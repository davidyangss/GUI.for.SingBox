---
name: "system-proxy-network-service-not-found"
description: "修复 macOS 系统代理设置时 networksetup 报错 'Unable to find item in network database'。当用户报告系统代理设置失败、错误信息包含 Ethernet 或 networksetup 相关错误时调用此 skill。"
---

# System Proxy Network Service Not Found

Use this skill when working in `GUI.for.SingBox` and the user reports:

- 系统代理设置失败，错误包含 `Unable to find item in network database`
- networksetup 命令报错找不到 `Ethernet` 服务
- 参数错误如 `127.0.0.17897` (IP 和端口连在一起)
- macOS 上没有以太网接口但代码尝试配置 Ethernet

## Root Cause

**Files**: 
- `bridge/system_proxy.go:441` — `getDarwinSystemProxyBypass()` 硬编码 `["Ethernet", "Wi-Fi"]`
- `frontend/src/stores/appSettings.ts:144` — 默认 `systemProxyServices` 硬编码 `['Ethernet', 'Wi-Fi']`

很多 Mac 没有 Ethernet 网络服务（只有 Wi-Fi 和 Thunderbolt Bridge），导致 `networksetup` 命令失败。

## Fix Summary

1. **后端**: 新增 `getDarwinNetworkServices()` / `GetNetworkServices()` 动态获取实际网络服务列表
2. **后端**: 修复 `getDarwinSystemProxyBypass()` 使用动态列表
3. **后端**: `setDarwinSystemProxy()` 在执行前过滤掉不存在的服务（防御性校验，兼容存量配置）
4. **前端**: 添加 `GetNetworkServices` bridge 绑定
5. **前端**: 初始化时用实际服务列表替换硬编码默认值，自动迁移已存储的错误值

## Implementation Details

### 1. Backend: `bridge/system_proxy.go`

#### Add `getDarwinNetworkServices()` helper:

```go
func getDarwinNetworkServices() ([]string, error) {
	out, err := runSystemProxyCommand("networksetup", "-listallnetworkservices")
	if err != nil {
		return nil, err
	}

	services := []string{}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		// Skip the header line and disabled services (marked with *)
		if line == "" || strings.HasPrefix(line, "An asterisk") || strings.HasPrefix(line, "*") {
			continue
		}
		services = append(services, line)
	}
	return services, nil
}
```

#### Add public `GetNetworkServices()` method:

```go
func (a *App) GetNetworkServices() FlagResult {
	log.Printf("GetNetworkServices")

	var services []string
	var err error

	switch Env.OS {
	case "darwin":
		services, err = getDarwinNetworkServices()
	case "linux":
		// Linux doesn't use per-service proxy configuration
		services = []string{}
	case "windows":
		// Windows doesn't use per-service proxy configuration
		services = []string{}
	}

	if err != nil {
		return FlagResult{false, err.Error()}
	}

	servicesJSON, err := json.Marshal(services)
	if err != nil {
		return FlagResult{false, err.Error()}
	}

	return FlagResult{true, string(servicesJSON)}
}
```

#### Fix `getDarwinSystemProxyBypass()`:

```go
func getDarwinSystemProxyBypass() (string, error) {
	services, err := getDarwinNetworkServices()
	if err != nil {
		return "", err
	}

	result := []string{}
	for _, device := range services {
		out, err := runSystemProxyCommand("networksetup", "-getproxybypassdomains", device)
		if err != nil {
			// Skip services that don't support proxy settings
			continue
		}
		if strings.TrimSpace(out) == "" {
			continue
		}
		for item := range strings.SplitSeq(strings.TrimSpace(out), "\n") {
			item = strings.TrimSpace(item)
			if item != "" {
				result = append(result, item)
			}
		}
	}
	return strings.Join(result, ";"), nil
}
```

#### Add defensive filtering in `setDarwinSystemProxy()`:

This prevents errors even when the frontend passes stale service names from stored config (e.g., `['Ethernet', 'Wi-Fi']` on a Mac that only has Wi-Fi).

```go
func setDarwinSystemProxy(server string, enabled bool, proxyType string, bypass string, services []string) error {
	// Filter services against actually-available network services to avoid
	// "Unable to find item in network database" errors when stored config
	// contains stale entries like "Ethernet" on a Wi-Fi-only Mac.
	if available, err := getDarwinNetworkServices(); err == nil && len(available) > 0 {
		availableSet := make(map[string]bool, len(available))
		for _, s := range available {
			availableSet[s] = true
		}
		filtered := services[:0]
		for _, s := range services {
			if availableSet[strings.TrimSpace(s)] {
				filtered = append(filtered, s)
			}
		}
		// If all provided services were invalid, fall back to all available ones
		if len(filtered) == 0 {
			services = available
		} else {
			services = filtered
		}
	}

	commands := [][]string{}
	for _, device := range services {
		device = strings.TrimSpace(device)
		if device == "" {
			continue
		}
		// ... rest of function
```

**Why this matters**: Even with frontend migration logic, users who don't restart the app or have the frontend load before the backend fix would still hit errors. Backend validation ensures immediate relief.

### 2. Frontend Bridge: `frontend/src/bridge/wailsjs/go/bridge/`

#### `App.d.ts`:

```typescript
export function GetNetworkServices():Promise<bridge.FlagResult>;
```

#### `App.js`:

```javascript
export function GetNetworkServices() {
  return window['go']['bridge']['App']['GetNetworkServices']();
}
```

### 3. Frontend Bridge Wrapper: `frontend/src/bridge/app.ts`

```typescript
export const GetNetworkServices = async (): Promise<string[]> => {
  const { flag, data } = await App.GetNetworkServices()
  if (!flag) {
    throw data
  }
  return JSON.parse(data) as string[]
}
```

### 4. Frontend Settings: `frontend/src/stores/appSettings.ts`

#### Add import:

```typescript
import {
  GetSystemProxyBypass,
  GetNetworkServices,  // Add this
  ReadFile,
  WriteFile,
  // ...
} from '@/bridge'
```

#### Fix initialization logic (~line 141-154):

```typescript
if ('darwinSystemProxyServices' in settings) {
  settings.systemProxyServices = settings.darwinSystemProxyServices as string[]
  delete settings.darwinSystemProxyServices
}

// Get actual network services dynamically
const defaultSystemProxyServices = envStore.env.os === 'darwin' 
  ? (await ignoredError(GetNetworkServices)) || []
  : []

if (!data) {
  settings.systemProxyServices = defaultSystemProxyServices
} else if (!settings.systemProxyServices) {
  settings.systemProxyServices = defaultSystemProxyServices
} else if (
  envStore.env.os === 'linux' &&
  settings.systemProxyServices.join(',') === 'Ethernet,Wi-Fi'
) {
  settings.systemProxyServices = defaultSystemProxyServices
} else if (
  envStore.env.os === 'darwin' &&
  settings.systemProxyServices.join(',') === 'Ethernet,Wi-Fi'
) {
  // Fix hardcoded default for macOS users - replace with actual services
  settings.systemProxyServices = defaultSystemProxyServices
}
```

## Testing

1. 验证 Go 编译：
   ```bash
   go build -o /dev/null ./bridge
   go vet ./bridge
   ```

2. 查看实际网络服务：
   ```bash
   networksetup -listallnetworkservices
   ```

3. 启动应用，测试系统代理开关

4. 检查日志，确认不再出现 "Unable to find item in network database" 错误

## Version Update Checklist

After upstream merges, verify:

- [ ] `bridge/system_proxy.go` contains `GetNetworkServices()` method
- [ ] `getDarwinSystemProxyBypass()` uses `getDarwinNetworkServices()` instead of hardcoded list
- [ ] Frontend bridge exports `GetNetworkServices`
- [ ] `appSettings.ts` uses dynamic service detection for macOS
- [ ] Hardcoded `['Ethernet', 'Wi-Fi']` check exists for both darwin and linux

Search patterns:

```typescript
// Frontend
systemProxyServices.*Ethernet.*Wi-Fi

// Backend
for _, device := range []string{"Ethernet"
```

## Impact

- **Files Modified**: 
  - `bridge/system_proxy.go`
  - `frontend/src/bridge/wailsjs/go/bridge/App.d.ts`
  - `frontend/src/bridge/wailsjs/go/bridge/App.js`
  - `frontend/src/bridge/app.ts`
  - `frontend/src/stores/appSettings.ts`
- **Risk**: Low — graceful fallback for all platforms; existing saved configs auto-fixed on next load
- **Compatibility**: Fully backward compatible; users with stored `['Ethernet', 'Wi-Fi']` will be auto-migrated to actual services
- **Platform**: macOS-specific fix; Linux/Windows behavior unchanged (empty array)
