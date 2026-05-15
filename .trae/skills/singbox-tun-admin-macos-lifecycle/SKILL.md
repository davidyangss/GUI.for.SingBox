---
name: "singbox-tun-admin-macos-lifecycle"
description: "Documents and reapplies GUI.for.SingBox macOS TUN/admin/restart UX fixes. Invoke when syncing upstream or debugging TUN permission, restart, startup-error, or UI state issues."
---

# GUI.for.SingBox macOS TUN/Admin Lifecycle Fixes

Use this skill when working on the macOS TUN experience in `GUI.for.SingBox`, especially when any of the following regress:

- `tun` mode requires admin privileges and Touch ID / password authorization
- changing `tun` intent should not silently auto-restart in some flows
- `tun` state, tray/menu state, and overview UI become inconsistent
- root-started `sing-box` cannot be stopped or restarted cleanly
- startup fails but UI incorrectly shows a normal `INFO[...]` log as the error
- overview/tray/title-bar restart entries behave differently after upstream sync

## Goal

Keep the macOS `tun` lifecycle predictable:

1. `tun` is a persisted startup intent, not a one-off runtime toggle
2. core only starts in `tun` mode when the profile actually has a `tun` inbound and user intent is enabled
3. macOS admin elevation is requested only when needed
4. root-started `sing-box` can still be stopped and restarted
5. UI status, tray status, and persisted state stay aligned
6. startup failures surface the real error instead of a random trailing info log

---

## Feature Summary

This feature set was improved incrementally to solve a chain of macOS-specific problems:

### Phase 1: Separate `tun` intent from live runtime config

Problem:

- old behavior mixed "profile has tun inbound", "runtime tun enabled", and "user wants next startup to use tun"
- editing config could auto-restart unexpectedly
- app restart did not reliably remember previous `tun` startup intent

Fix:

- add persistent `app.kernel.tunMode`
- make `tunMode` the single source of truth for "next startup should use tun"
- only apply `tunMode` to the profile right before generating core config

Key files:

- `frontend/src/types/app.d.ts`
- `frontend/src/stores/appSettings.ts`
- `frontend/src/stores/kernelApi.ts`

### Phase 2: Only launch `tun` when both config and intent allow it

Problem:

- user could request `tun` startup while current profile had no `tun` inbound
- startup path could enter inconsistent state

Fix:

- before startup, require both:
  - `tunMode === true`
  - current profile contains a `tun` inbound
- otherwise throw `home.overview.needTun`

Key file:

- `frontend/src/stores/kernelApi.ts`

### Phase 3: Add macOS admin launch for TUN startup

Problem:

- `sing-box` TUN startup on macOS needs elevated privileges
- previous non-admin startup failed with:
  - `configure tun interface: Connect: operation not permitted`

Fix:

- in Go bridge, add `osascript ... with administrator privileges`
- use admin launch only when:
  - OS is macOS
  - this startup should use `tun`
- keep normal startup path for non-`tun` launches

Key file:

- `bridge/exec.go`

Behavior:

- system shows macOS admin authorization UI
- Touch ID availability depends on the user's macOS security policy

### Phase 4: Fix overview "Start Core" hanging even though core already started

Problem:

- overview page could remain in `starting` state
- core might already be alive, but UI waited for a fragile single log signal

Fix:

- add fallback startup readiness logic:
  - read actual PID file
  - poll process existence
  - accept stable alive process even if single expected log timing is missed

Key file:

- `frontend/src/stores/kernelApi.ts`

### Phase 5: Fix stopping/restarting root-started `tun` core

Problem:

- after admin-started `tun`, normal `KillProcess` could fail with `EPERM`
- symptoms:
  - stop fails
  - restart fails
  - disable `tun` then restart can fail

Fix:

- in `KillProcess`, if normal signal is denied on macOS:
  - retry using admin shell
  - first `kill -INT`
  - if graceful stop times out, escalate to `kill -KILL`

Key file:

- `bridge/exec.go`

### Phase 6: Stabilize "switch off tun then restart"

Problem:

- after stopping a previous `tun` runtime, macOS might not release resources immediately
- next non-`tun` launch could fail sporadically

Fix:

- before startup, remove stale `pid/log` files
- when switching from live `tun` to non-`tun`, add a short cooldown after stop

Key file:

- `frontend/src/stores/kernelApi.ts`

### Phase 7: Sync overview switch, tray state, editor state, and reminders

Problem:

- tray menu, overview switch, and profile editor `tun` switch could drift
- user needed stronger "restart required" visibility

Fix:

- make overview switch and tray menu operate on persistent `tunMode`
- sync inbound editor `tun` enable state with the same intent
- add visible restart reminders in:
  - title bar
  - tray tooltip/menu
  - overview (later partially reduced to avoid duplication)

Key files:

- `frontend/src/views/HomeView/components/OverView.vue`
- `frontend/src/views/ProfilesView/components/InboundsConfig.vue`
- `frontend/src/utils/tray.ts`
- `frontend/src/components/_common/TitleBar.vue`
- `frontend/src/lang/locale/zh.ts`
- `frontend/src/lang/locale/en.ts`

### Phase 8: Improve tray action feedback and title-bar restart behavior

Problem:

- tray async actions had weak feedback
- title-bar restart button could be swallowed by draggable area

Fix:

- wrap tray async actions with unified success/error handling
- optionally show main window after tray `tun` changes
- move title-bar restart action into a non-draggable region

Key files:

- `frontend/src/utils/tray.ts`
- `frontend/src/components/_common/TitleBar.vue`

### Phase 9: Make overview `tun` switch restart immediately

Problem:

- user wanted overview `Tun模式` click to immediately enter restart flow
- but still wanted a top-level restart-required entry elsewhere

Fix:

- add `setTunMode(enable, restartIfRunning)`
- overview switch uses `setTunMode(..., true)` for immediate restart
- title bar keeps the manual restart entry for other restart-required cases
- remove duplicate overview restart-required entry to avoid repeated UI

Key files:

- `frontend/src/stores/kernelApi.ts`
- `frontend/src/views/HomeView/components/OverView.vue`
- `frontend/src/views/HomeView/index.vue`
- `frontend/src/components/_common/TitleBar.vue`

### Phase 10: Fix startup error reporting

Problem:

- if startup failed, UI could show a harmless trailing line like:
  - `INFO[0000] network: updated default interface en0, index 7`
- this misled debugging because the popup content was not the real failure

Root cause:

- previous code used the latest emitted line as the rejection message
- if the core exited right after an `INFO` line, that `INFO` line became the displayed error

Fix:

- scan complete log output and prefer real error lines matching:
  - `FATAL`
  - `ERROR`
  - `permission denied`
  - `operation not permitted`
  - `timeout`
  - `failed`
  - `canceled/cancelled`
- on startup timeout, read log file and surface the best real error first
- only fall back to generic error when no useful error line exists

Key file:

- `frontend/src/stores/kernelApi.ts`

### Phase 11: Make tray `tun` actions expose the title-bar restart reminder immediately

Problem:

- user toggled `启用/禁用 tun` from tray
- tray action succeeded, but the title-bar `重启生效` reminder was not immediately visible if main window was still hidden

Fix:

- make tray `tun` actions show the main window before applying the change
- this ensures the updated title-bar state is immediately visible after tray interaction
- keep toast/error handling after the window is shown

Key file:

- `frontend/src/utils/tray.ts`

### Phase 12: Fix restart hanging when stop event does not come back

Problem:

- sometimes clicking restart could not complete
- core process was already gone, but frontend still waited forever for the stop event/promise

Root cause:

- `KillProcess()` may already have succeeded
- but frontend still blocked on `coreStoppedPromise`
- if the stop event was lost or delayed, restart looked stuck even though `sing-box` had already been terminated

Fix:

- add `waitForCoreStopped()`
- wait briefly for the stop event
- if event does not arrive in time, check the real process state
- if process is already gone, call `onCoreStopped()` manually and continue restart
- only fail when the process is still alive after the fallback check

Key file:

- `frontend/src/stores/kernelApi.ts`

### Phase 13: Wait for controller release and make title-bar restart prompt more obvious

Problem:

- restart could still fail with:
  - `listen tcp 126.0.0.1:20123: bind: address already in use`
- this often recovered if the user waited a moment and retried manually
- after tray `禁用 tun`, the main window did open, but the title-bar restart prompt was still not obvious enough

Root cause:

- old core process could be gone while the Clash API / `external_controller` port was not fully released yet
- restart path started the new core too soon
- title bar only showed a relatively subtle `重启生效` reminder

Fix:

- derive the current `external_controller` endpoint from the active profile
- after `stopCore()`, poll the controller URL until it becomes unreachable or timeout expires
- if startup still fails with `address already in use`, sleep briefly and retry startup once
- change window title suffix from `重启生效` to `重启核心`
- show a stronger title-bar prompt by:
  - tinting the title bar red
  - injecting `重启核心` directly into the title text
  - upgrading the restart button to a more prominent primary action

Key files:

- `frontend/src/stores/kernelApi.ts`
- `frontend/src/components/_common/TitleBar.vue`

---

## Current Expected Behavior

### `tun` state model

- `tunMode` means: "next startup should use tun"
- it is persisted across app restarts
- startup only uses `tun` if the chosen profile actually contains a `tun` inbound

### Overview behavior

- clicking overview `Tun模式` while core is running:
  - toggles `tunMode`
  - immediately enters restart flow
- no duplicated restart-required badge/button remains in overview top row

### Title bar behavior

- title bar keeps the prominent `重启生效 / 重启核心` entry
- when restart is required, the title text itself visibly includes `重启核心`
- this is the primary visible manual restart entry

### Tray behavior

- tray `启用/禁用 tun` changes the same persisted `tunMode`
- tray `启用/禁用 tun` shows the main window first so title-bar `重启生效` becomes visible immediately
- tray action errors are caught and surfaced more clearly
- tray can show window around important `tun` actions

### Admin behavior

- starting `tun` on macOS requests admin authorization
- stopping a root-started core can also require admin authorization
- whether Touch ID appears is determined by macOS, not by app code alone

### Startup error behavior

- startup failure should show the real `FATAL/ERROR/...` line when available
- random trailing `INFO[...]` lines should no longer be used as the popup error

### Restart timing behavior

- restart waits briefly for the previous `external_controller` listener to disappear
- if startup still hits `address already in use`, frontend retries once after a short delay

---

## Files And Responsibilities

| File | Responsibility |
|------|----------------|
| `bridge/exec.go` | macOS admin launch and admin-assisted stop/kill |
| `frontend/src/stores/kernelApi.ts` | `tunMode` persistence binding, startup/restart/stop lifecycle, error extraction |
| `frontend/src/stores/appSettings.ts` | persistent app settings including `tunMode` |
| `frontend/src/types/app.d.ts` | type definition for stored `tunMode` |
| `frontend/src/views/HomeView/components/OverView.vue` | overview switches and direct restart-on-tun-toggle |
| `frontend/src/views/HomeView/index.vue` | avoid flashing back to cold-start page during restart |
| `frontend/src/components/_common/TitleBar.vue` | title-bar restart-required entry and safe clickable region |
| `frontend/src/utils/tray.ts` | tray menus, restart reminder, action feedback |
| `frontend/src/views/ProfilesView/components/InboundsConfig.vue` | inbound editor `tun` switch sync |
| `frontend/src/lang/locale/zh.ts` | Chinese UI text additions |
| `frontend/src/lang/locale/en.ts` | English UI text additions |

---

## Reapply Checklist After Upstream Sync

When upstream changes these areas, re-check and reapply this feature set in roughly this order:

1. `kernelApi.ts`
   - confirm `tunMode` is still persisted
   - confirm `setTunMode()` still exists or re-add equivalent logic
   - confirm startup error extraction still prefers real error lines
   - confirm restart keeps runtime profile when needed
2. `exec.go`
   - confirm admin launch path still uses `osascript ... with administrator privileges`
   - confirm permission-denied stop path still retries with admin shell
3. `OverView.vue`
   - confirm `Tun模式` still restarts immediately
   - confirm duplicate restart-required controls are not reintroduced
4. `TitleBar.vue`
   - confirm title-bar restart entry still exists
   - confirm button is outside draggable area
5. `tray.ts`
   - confirm tray `tun` actions target persisted `tunMode`
   - confirm tray async actions still have error handling
   - confirm tray `tun` actions show main window before applying change
6. `InboundsConfig.vue`
   - confirm profile editor `tun` switch still syncs with global intent if required by current design
7. `kernelApi.ts` stop/restart flow
   - confirm `waitForCoreStopped()` or equivalent fallback still exists
   - confirm restart does not block forever if stop event is missing but process is already dead
   - confirm restart still waits for controller release and retries once on `address already in use`

---

## Diagnostics And Validation

### Build validation

Run:

```bash
cd /private/idata/icoding/projects/singbox/GUI.for.SingBox.git/frontend
pnpm install --frozen-lockfile
pnpm build
```

Then:

```bash
cd /private/idata/icoding/projects/singbox/GUI.for.SingBox.git
go build ./...
wails build
codesign --force --deep --sign "yssbook Local Code Signing" --timestamp=none build/bin/GUI.for.SingBox.app
```

### Runtime validation

Check these scenarios:

1. overview click `Tun模式` while core is running
   - immediate restart begins
   - if enabling `tun`, macOS admin auth is requested
2. `tun` core stop
   - stop works even if the running core was admin-started
3. `tun` core restart
   - restart works even if the previous core was admin-started
   - restart does not hang if stop event is delayed but process has already exited
   - restart tolerates short-lived `external_controller` port release delays
4. disable `tun` then restart
   - new startup becomes non-`tun`
   - title bar clearly shows `重启核心` after tray `禁用 tun`
5. app relaunch
   - previous `tunMode` persists
6. startup failure
   - popup shows real `FATAL/ERROR/...`, not a harmless `INFO[...]`

### Installed app verification

Check current installed app:

```bash
python3 - <<'PY'
from pathlib import Path
p = Path('/Applications/GUI.for.SingBox.app/Contents/MacOS/GUI.for.SingBox')
print(p.exists())
if p.exists():
    data = p.read_bytes()
    for needle in [
        b'setTunMode',
        b'KillProcess: retrying with macOS administrator privileges for pid',
        b'home.overview.manualRestartCore',
    ]:
        print(needle.decode('utf-8', 'ignore'), needle in data)
PY
```

If sandbox blocks `/Applications`, user must copy manually:

```bash
cp -R "/private/idata/icoding/projects/singbox/GUI.for.SingBox.git/build/bin/GUI.for.SingBox.app" /Applications/
```

If needed:

```bash
sudo cp -R "/private/idata/icoding/projects/singbox/GUI.for.SingBox.git/build/bin/GUI.for.SingBox.app" /Applications/
```

---

## Common Failure Patterns

### Symptom: `tun` start fails with `operation not permitted`

Likely cause:

- core was started without admin path

Check:

- `bridge/exec.go`
- startup log line:
  - `[gui] launch core: tunMode=true admin=true os=darwin`

### Symptom: `tun` starts but cannot stop/restart

Likely cause:

- root-started process was stopped via non-admin signal only

Check:

- `KillProcess` macOS permission-denied fallback in `bridge/exec.go`

### Symptom: disable `tun`, then restart sometimes fails

Likely cause:

- stale pid/log files, delayed release of previous TUN resources, or delayed release of the previous `external_controller` listener

Check:

- startup cleanup of `CorePidFilePath` and `CoreLogFilePath`
- post-stop cooldown when switching off `tun`
- controller release polling / one-time retry in `restartCore()`

### Symptom: popup shows harmless `INFO[...]` as startup error

Likely cause:

- last log line was being reused as the failure reason

Check:

- startup error extraction in `runCoreProcess()` inside `kernelApi.ts`

### Symptom: restart button looks clickable but does nothing

Likely cause:

- button is inside draggable title-bar region

Check:

- `TitleBar.vue` uses `--wails-draggable: disabled` around actionable controls

### Symptom: tray toggles `tun` but user cannot immediately see `重启生效`

Likely cause:

- main window stayed hidden during tray action

Check:

- `runTrayAction()` in `tray.ts` should show the main window before applying tray `tun` changes

### Symptom: restart cannot finish even though `sing-box` should already be gone

Likely cause:

- frontend is stuck waiting for `coreStoppedPromise`
- stop event did not return, but process has already exited

Check:

- `waitForCoreStopped()` fallback in `kernelApi.ts`
- whether fallback probes real process state via `ProcessInfo()`

---

## Search Hints

If structure changes after upstream sync, search for:

- `tunMode`
- `setTunMode`
- `runCoreProcess`
- `waitForCoreStopped`
- `waitForControllerReleased`
- `KillProcess: retrying with macOS administrator privileges`
- `home.overview.manualRestartCore`
- `with administrator privileges`
- `needRestart`
- `OnUrlOpen`
- `updateTrayAndMenus`

---

## Output Expectations

When using this skill, report:

- whether current bug is about persisted `tun` intent, admin launch, admin stop, restart flow, tray/title-bar/overview inconsistency, or startup error reporting
- which files were checked and changed
- whether `pnpm build` / `go build ./...` / `wails build` passed
- whether installed app is actually the latest bundle
- whether `/Applications` install was blocked by sandbox and which manual copy command user should run

---

## Example Use

Invoke this skill when user says things like:

- "macOS 下开启 tun 后停止不了"
- "tun 模式改完后状态和界面不一致"
- "首页点 Tun模式 应该直接重启"
- "菜单栏和标题栏的重启提示重复了"
- "启动失败时弹出来的是 INFO，不是真正错误"
- "同步 upstream 后把 tun/admin/restart 那套补丁重新打回去"
