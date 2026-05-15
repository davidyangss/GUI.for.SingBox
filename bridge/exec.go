package bridge

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	sysruntime "runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/shirou/gopsutil/v3/process"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func escapeAppleScriptString(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	return strings.ReplaceAll(value, "\"", "\\\"")
}

func buildShellCommand(path string, args []string, options ExecOptions, pidPath string, logPath string) string {
	parts := []string{}

	if options.WorkingDirectory != "" {
		parts = append(parts, "cd "+shellQuote(options.WorkingDirectory))
	}

	for key, value := range options.Env {
		parts = append(parts, "export "+key+"="+shellQuote(value))
	}

	command := "exec " + shellQuote(path)
	for _, arg := range args {
		command += " " + shellQuote(arg)
	}

	if pidPath != "" {
		command = "echo $$ > " + shellQuote(pidPath) + "; " + command
	}

	if logPath != "" {
		command += " >> " + shellQuote(logPath) + " 2>&1"
	}

	parts = append(parts, command)
	return strings.Join(parts, "; ")
}

func buildDarwinAdminCommand(path string, args []string, options ExecOptions, pidPath string, logPath string) *exec.Cmd {
	shellCmd := buildShellCommand(path, args, options, pidPath, logPath)
	appleScript := fmt.Sprintf(`do shell script "%s" with administrator privileges`, escapeAppleScriptString(shellCmd))
	cmd := exec.Command("osascript", "-e", appleScript)
	SetCmdWindowHidden(cmd)
	return cmd
}

func runDarwinAdminShell(shellCmd string) error {
	appleScript := fmt.Sprintf(`do shell script "%s" with administrator privileges`, escapeAppleScriptString(shellCmd))
	cmd := exec.Command("osascript", "-e", appleScript)
	SetCmdWindowHidden(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		output := strings.TrimSpace(string(out))
		if output == "" {
			output = err.Error()
		}
		return errors.New(output)
	}
	return nil
}

func isPermissionDenied(err error) bool {
	if err == nil {
		return false
	}
	var errno syscall.Errno
	if errors.As(err, &errno) && errno == syscall.EPERM {
		return true
	}
	lowerErr := strings.ToLower(err.Error())
	return strings.Contains(lowerErr, "operation not permitted") || strings.Contains(lowerErr, "permission denied")
}

func waitForProcessExitWithTimeoutNoKill(process *os.Process, timeoutSeconds int) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	interval := 10 * time.Millisecond
	maxInterval := 1000 * time.Millisecond

	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("timed out after %d seconds waiting for process %d", timeoutSeconds, process.Pid)
		default:
			alive, err := IsProcessAlive(process)
			if err != nil {
				return fmt.Errorf("failed to check status of process %d: %w", process.Pid, err)
			}
			if !alive {
				return nil
			}

			time.Sleep(interval)
			interval = min(time.Duration(interval*2), maxInterval)
		}
	}
}

func terminateDarwinAdminProcess(process *os.Process, timeout int) error {
	log.Printf("KillProcess: retrying with macOS administrator privileges for pid %d", process.Pid)

	if err := runDarwinAdminShell(fmt.Sprintf("kill -INT %d", process.Pid)); err != nil {
		return err
	}
	if err := waitForProcessExitWithTimeoutNoKill(process, timeout); err == nil {
		return nil
	} else {
		log.Printf("KillProcess: graceful admin stop timed out for pid %d: %v", process.Pid, err)
	}

	if err := runDarwinAdminShell(fmt.Sprintf("kill -KILL %d", process.Pid)); err != nil {
		return err
	}
	return waitForProcessExitWithTimeoutNoKill(process, min(timeout, 5))
}

func (a *App) Exec(path string, args []string, options ExecOptions) FlagResult {
	log.Printf("Exec: %s %s %v", path, args, options)

	exePath := resolvePath(path)

	if _, err := os.Stat(exePath); os.IsNotExist(err) {
		exePath = path
	}

	cmd := exec.Command(exePath, args...)
	SetCmdWindowHidden(cmd)

	cmd.Dir = options.WorkingDirectory
	cmd.Env = os.Environ()

	for key, value := range options.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}

	out, err := cmd.CombinedOutput()

	var output string
	if options.Convert {
		output = strings.TrimSpace(decodeGB18030(out))
	} else {
		output = strings.TrimSpace(string(out))
	}

	if err != nil {
		if output == "" {
			output = err.Error()
		}
		return FlagResult{false, output}
	}

	return FlagResult{true, output}
}

func (a *App) ExecBackground(path string, args []string, outEvent string, endEvent string, options ExecOptions) FlagResult {
	log.Printf("ExecBackground: %s %s %s %s %v", path, args, outEvent, endEvent, options)

	exePath := resolvePath(path)
	pidPath := ""
	logPath := ""
	useDarwinAdmin := options.Admin && sysruntime.GOOS == "darwin"

	if _, err := os.Stat(exePath); os.IsNotExist(err) {
		exePath = path
	}

	if options.PidFile != "" {
		pidPath = resolvePath(options.PidFile)
		if err := os.MkdirAll(filepath.Dir(pidPath), os.ModePerm); err != nil {
			return FlagResult{false, err.Error()}
		}
	}

	var cmd *exec.Cmd
	var stdout io.ReadCloser
	var err error
	var logFile *os.File

	switch {
	case options.LogFile != "":
		logPath = resolvePath(options.LogFile)
		if err := os.MkdirAll(filepath.Dir(logPath), os.ModePerm); err != nil {
			return FlagResult{false, err.Error()}
		}

		if useDarwinAdmin {
			if err := os.WriteFile(logPath, nil, 0644); err != nil {
				return FlagResult{false, err.Error()}
			}
		} else {
			logFile, err = os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
			if err != nil {
				return FlagResult{false, err.Error()}
			}
			defer logFile.Close()

			cmd = exec.Command(exePath, args...)
			SetCmdWindowHidden(cmd)
			cmd.Dir = options.WorkingDirectory
			cmd.Env = os.Environ()
			for key, value := range options.Env {
				cmd.Env = append(cmd.Env, key+"="+value)
			}
			cmd.Stdout = logFile
			cmd.Stderr = logFile
		}

	case outEvent != "" && !useDarwinAdmin:
		cmd = exec.Command(exePath, args...)
		SetCmdWindowHidden(cmd)
		cmd.Dir = options.WorkingDirectory
		cmd.Env = os.Environ()
		for key, value := range options.Env {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
		stdout, err = cmd.StdoutPipe()
		if err != nil {
			return FlagResult{false, err.Error()}
		}
		cmd.Stderr = cmd.Stdout
	}

	if useDarwinAdmin {
		log.Printf("ExecBackground: using macOS administrator privileges for %s", exePath)
		if outEvent != "" && logPath == "" {
			return FlagResult{false, "admin background execution requires LogFile"}
		}
		cmd = buildDarwinAdminCommand(exePath, args, options, pidPath, logPath)
	}

	if cmd == nil {
		cmd = exec.Command(exePath, args...)
		SetCmdWindowHidden(cmd)
		cmd.Dir = options.WorkingDirectory
		cmd.Env = os.Environ()
		for key, value := range options.Env {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}

	done := make(chan struct{})
	if err := cmd.Start(); err != nil {
		return FlagResult{false, err.Error()}
	}

	pid := strconv.Itoa(cmd.Process.Pid)

	if pidPath != "" && !useDarwinAdmin {
		if err := os.WriteFile(pidPath, []byte(pid), os.ModePerm); err != nil {
			_ = SendExitSignal(cmd.Process)
			_ = waitForProcessExitWithTimeout(cmd.Process, 10)
			_ = cmd.Wait()
			return FlagResult{false, err.Error()}
		}
	}

	if outEvent != "" {
		if logPath != "" {
			go tailAndEmitLogFile(a, logPath, outEvent, options, done)
		} else {
			scanAndEmit := func(reader io.Reader) {
				scanner := bufio.NewScanner(reader)
				scanner.Buffer(make([]byte, 64*1024), 1024*1024)
				stopOutput := false
				for scanner.Scan() {
					var text string
					if options.Convert {
						text = decodeGB18030(scanner.Bytes())
					} else {
						text = scanner.Text()
					}

					if !stopOutput {
						runtime.EventsEmit(a.Ctx, outEvent, text)

						if options.StopOutputKeyword != "" && strings.Contains(text, options.StopOutputKeyword) {
							stopOutput = true
						}
					}
				}
			}

			go scanAndEmit(stdout)
		}
	}

	go func() {
		defer close(done)

		err := cmd.Wait()
		if pidPath != "" {
			_ = os.Remove(pidPath)
		}
		if endEvent != "" {
			if err != nil {
				runtime.EventsEmit(a.Ctx, endEvent, err.Error())
				return
			}
			runtime.EventsEmit(a.Ctx, endEvent)
		}
	}()

	return FlagResult{true, pid}
}

func (a *App) ProcessInfo(pid int32) FlagResult {
	log.Printf("ProcessInfo: %d", pid)

	proc, err := process.NewProcess(pid)
	if err != nil {
		return FlagResult{false, err.Error()}
	}

	name, err := proc.Name()
	if err == nil && name != "" {
		return FlagResult{true, name}
	}

	exePath, exeErr := proc.Exe()
	if exeErr == nil && exePath != "" {
		return FlagResult{true, filepath.Base(exePath)}
	}

	cmdline, cmdlineErr := proc.CmdlineSlice()
	if cmdlineErr == nil && len(cmdline) > 0 && cmdline[0] != "" {
		return FlagResult{true, filepath.Base(cmdline[0])}
	}

	errs := []string{}
	if err != nil {
		errs = append(errs, "name: "+err.Error())
	}
	if exeErr != nil {
		errs = append(errs, "exe: "+exeErr.Error())
	}
	if cmdlineErr != nil {
		errs = append(errs, "cmdline: "+cmdlineErr.Error())
	}

	if len(errs) == 0 {
		return FlagResult{false, "failed to resolve process info"}
	}

	return FlagResult{false, strings.Join(errs, "; ")}
}

func (a *App) ProcessMemory(pid int32) FlagResult {
	log.Printf("ProcessMemory: %d", pid)

	proc, err := process.NewProcess(pid)
	if err != nil {
		return FlagResult{false, err.Error()}
	}

	memInfo, err := proc.MemoryInfo()
	if err == nil && memInfo != nil {
		return FlagResult{true, strconv.FormatUint(memInfo.RSS, 10)}
	}

	if sysruntime.GOOS == "darwin" {
		rss, fallbackErr := getDarwinProcessRSS(pid)
		if fallbackErr == nil {
			return FlagResult{true, strconv.FormatUint(rss, 10)}
		}
		return FlagResult{false, fmt.Sprintf("memory info: %v; ps fallback: %v", err, fallbackErr)}
	}

	return FlagResult{false, err.Error()}
}

func findProcessesByName(targetName string) ([]int32, error) {
	allProcs, err := process.Processes()
	if err != nil {
		return nil, fmt.Errorf("failed to list processes: %w", err)
	}

	var matched []int32
	for _, proc := range allProcs {
		pid := proc.Pid

		name, err := proc.Name()
		if err == nil && name == targetName {
			matched = append(matched, pid)
			continue
		}

		exePath, err := proc.Exe()
		if err == nil && filepath.Base(exePath) == targetName {
			matched = append(matched, pid)
			continue
		}

		cmdline, err := proc.CmdlineSlice()
		if err == nil && len(cmdline) > 0 && filepath.Base(cmdline[0]) == targetName {
			matched = append(matched, pid)
		}
	}

	return matched, nil
}

func (a *App) KillStaleCoreProcesses() FlagResult {
	log.Printf("KillStaleCoreProcesses")

	matchedPids, err := findProcessesByName("sing-box")
	if err != nil {
		return FlagResult{false, err.Error()}
	}

	if len(matchedPids) == 0 {
		return FlagResult{true, "0"}
	}

	var killedCount int
	var errors []string

	for _, pid := range matchedPids {
		osProcess, err := os.FindProcess(int(pid))
		if err != nil {
			errors = append(errors, fmt.Sprintf("find %d: %v", pid, err))
			continue
		}

		if err := SendExitSignal(osProcess); err != nil {
			log.Printf("KillStaleCoreProcesses: SendExitSignal for pid %d failed: %s", pid, err.Error())
			if sysruntime.GOOS == "darwin" && isPermissionDenied(err) {
				if adminErr := terminateDarwinAdminProcess(osProcess, 10); adminErr != nil {
					errors = append(errors, fmt.Sprintf("admin kill %d: %v", pid, adminErr))
					continue
				}
			} else {
				errors = append(errors, fmt.Sprintf("signal %d: %v", pid, err))
				continue
			}
		}

		if waitErr := waitForProcessExitWithTimeout(osProcess, 10); waitErr != nil {
			errors = append(errors, fmt.Sprintf("wait %d: %v", pid, waitErr))
			continue
		}

		killedCount++
		log.Printf("KillStaleCoreProcesses: killed stale sing-box pid %d", pid)
	}

	if len(errors) > 0 {
		return FlagResult{false, fmt.Sprintf("killed %d/%d, errors: %s", killedCount, len(matchedPids), strings.Join(errors, "; "))}
	}

	return FlagResult{true, strconv.Itoa(killedCount)}
}

func (a *App) KillProcess(pid int, timeout int) FlagResult {
	log.Printf("KillProcess: %d %d", pid, timeout)

	process, err := os.FindProcess(pid)
	if err != nil {
		return FlagResult{false, err.Error()}
	}

	if err := SendExitSignal(process); err != nil {
		log.Printf("SendExitSignal Err: %s", err.Error())
		if sysruntime.GOOS == "darwin" && isPermissionDenied(err) {
			if err := terminateDarwinAdminProcess(process, timeout); err != nil {
				return FlagResult{false, err.Error()}
			}
			return FlagResult{true, "Success"}
		}
	}

	if err := waitForProcessExitWithTimeout(process, timeout); err != nil {
		return FlagResult{false, err.Error()}
	}

	return FlagResult{true, "Success"}
}

func waitForProcessExitWithTimeout(process *os.Process, timeoutSeconds int) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	interval := 10 * time.Millisecond
	maxInterval := 1000 * time.Millisecond

	for {
		select {
		case <-ctx.Done():
			if killErr := process.Kill(); killErr != nil {
				return fmt.Errorf("timed out after %d seconds waiting for process %d, and failed to kill it: %w", timeoutSeconds, process.Pid, killErr)
			}
			return nil

		default:
			alive, err := IsProcessAlive(process)
			if err != nil {
				return fmt.Errorf("failed to check status of process %d: %w", process.Pid, err)
			}
			if !alive {
				return nil
			}

			time.Sleep(interval)
			interval = min(time.Duration(interval*2), maxInterval)
		}
	}
}

func getDarwinProcessRSS(pid int32) (uint64, error) {
	out, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(int(pid))).CombinedOutput()
	if err != nil {
		output := strings.TrimSpace(string(out))
		if output == "" {
			return 0, err
		}
		return 0, fmt.Errorf("%v: %s", err, output)
	}

	rssKB := strings.TrimSpace(string(out))
	if rssKB == "" {
		return 0, fmt.Errorf("empty rss output")
	}

	rss, err := strconv.ParseUint(rssKB, 10, 64)
	if err != nil {
		return 0, err
	}

	return rss * 1024, nil
}

func tailAndEmitLogFile(a *App, path string, outEvent string, options ExecOptions, done <-chan struct{}) {
	offset := int64(0)
	pending := ""
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	emitLine := func(text string) bool {
		if options.Convert {
			text = decodeGB18030([]byte(text))
		}
		text = strings.TrimRight(text, "\r")

		if text == "" {
			return false
		}

		runtime.EventsEmit(a.Ctx, outEvent, text)
		return options.StopOutputKeyword != "" && strings.Contains(text, options.StopOutputKeyword)
	}

	readNewContent := func(flush bool) bool {
		data, nextOffset, err := readFileRange(path, offset)
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				log.Printf("Failed to read log file %s: %v", path, err)
			}
			return false
		}

		if len(data) == 0 {
			if flush && pending != "" {
				return emitLine(pending)
			}
			offset = nextOffset
			return false
		}

		offset = nextOffset
		chunk := pending + string(data)
		lines := strings.Split(chunk, "\n")
		pending = lines[len(lines)-1]

		if slices.ContainsFunc(lines[:len(lines)-1], emitLine) {
			pending = ""
			return true
		}

		if flush && pending != "" {
			if emitLine(pending) {
				pending = ""
				return true
			}
			pending = ""
		}

		return false
	}

	for {
		select {
		case <-done:
			_ = readNewContent(true)
			return
		case <-ticker.C:
			if readNewContent(false) {
				return
			}
		}
	}
}

func readFileRange(path string, offset int64) ([]byte, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, offset, err
	}
	defer file.Close()

	stat, err := file.Stat()
	if err != nil {
		return nil, offset, err
	}

	size := stat.Size()
	if offset > size {
		offset = size
	}
	if size == offset {
		return nil, offset, nil
	}

	buf := make([]byte, size-offset)
	n, err := file.ReadAt(buf, offset)
	if err != nil && err != io.EOF {
		return nil, offset, err
	}

	return buf[:n], offset + int64(n), nil
}
