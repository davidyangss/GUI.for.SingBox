---
name: "kernel-stop-restart-freeze"
description: "修复核心停止/重启时 GUI 永久卡死的问题。当 sing-box 配置错误导致启动失败、停止/重启按钮无响应、插件钩子挂起或进程 kill 失败时调用此 skill。"
---

# Kernel Stop/Restart Freeze Fix

Use this skill when working in `GUI.for.SingBox` and the user encounters:

- 核心启动失败后，停止/重启按钮永久卡死
- sing-box 配置错误（如 `outbounds: []`, `missing tags`）导致 GUI 无响应
- 插件的 `onBeforeCoreStop` / `onCoreStopped` 钩子超时或抛异常
- `KillProcess` 对已崩溃进程操作失败
- GUI 重启后 pid.txt 残留，`isCoreStartedByThisInstance` 状态错乱

## Root Cause

**File**: `frontend/src/stores/kernelApi.ts`

### Issue 1: `runCoreProcess` probe loop has no timeout

```typescript
while (!stopped) {
  const ok = await probeApiAvailability().catch(() => false)
  if (ok) break
  if (stopped) throw 'Startup failed. Check logs for details.'
  await sleep(500)
}
```

If sing-box hangs (neither starts nor exits), loop runs forever and `starting.value` never resets in `finally`.

### Issue 2: `stopCore` waits indefinitely for `coreStoppedPromise`

```typescript
await (isCoreStartedByThisInstance ? coreStoppedPromise : onCoreStopped())
```

If `pluginsStore.onCoreStoppedTrigger()` hangs, promise never resolves, `stopping.value = true` forever, buttons locked.

### Issue 3: `onCoreStopped` async operations unprotected

```typescript
await RemoveFile(CorePidFilePath)      // throws if file missing
await envStore.updateSystemProxyStatus() // throws if system call fails
await pluginsStore.onCoreStoppedTrigger() // hangs if plugin stuck
coreStoppedResolver(null)              // never reached if above fail
```

### Issue 4: `isCoreStartedByThisInstance` not reset in `onCoreStopped`

Causes next startup to choose wrong wait path in `stopCore`.

## Fix

All changes in `frontend/src/stores/kernelApi.ts`:

### 1. Add 30-second startup timeout to `runCoreProcess`

```typescript
// Before
while (!stopped) {
  const ok = await probeApiAvailability().catch(() => false)
  if (ok) break
  if (stopped) throw 'Startup failed. Check logs for details.'
  await sleep(500)
}

// After
const startTime = Date.now()
const maxStartupWait = 30000 // 30 seconds max startup time

while (!stopped) {
  if (Date.now() - startTime > maxStartupWait) {
    throw 'Startup timeout. Check logs for details.'
  }
  const ok = await probeApiAvailability().catch(() => false)
  if (ok) break
  if (stopped) throw 'Startup failed. Check logs for details.'
  await sleep(500)
}
```

### 2. Add `withTimeout` utility function

Insert before `onCoreStopped` definition:

```typescript
const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} (${ms}ms)`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}
```

### 3. Harden `onCoreStopped` with error handling

```typescript
// Before
const onCoreStopped = async () => {
  if (!isCoreStartedByThisInstance) {
    await RemoveFile(CorePidFilePath)
  }
  corePid.value = -1
  running.value = false
  needRestart.value = false
  destroyWebsocket()
  await envStore.updateSystemProxyStatus()
  if (envStore.systemProxy) {
    await envStore.clearSystemProxy()
  }
  if (appSettingsStore.app.autoSetSystemDNS || envStore.systemDNSSet) {
    await envStore.setSystemDNS(false).catch((err) => message.error(err))
  }
  resetConfig()
  await pluginsStore.onCoreStoppedTrigger()
  coreStoppedResolver(null)
}

// After
const onCoreStopped = async () => {
  if (!isCoreStartedByThisInstance) {
    await RemoveFile(CorePidFilePath).catch(() => {})      // ✅ file missing OK
  }
  corePid.value = -1
  running.value = false
  isCoreStartedByThisInstance = false                      // ✅ reset state
  needRestart.value = false
  destroyWebsocket()
  await envStore.updateSystemProxyStatus().catch(() => {}) // ✅ system call fail OK
  if (envStore.systemProxy) {
    await envStore.clearSystemProxy().catch((err) => message.error(err))
  }
  if (appSettingsStore.app.autoSetSystemDNS || envStore.systemDNSSet) {
    await envStore.setSystemDNS(false).catch((err) => message.error(err))
  }
  resetConfig()
  await pluginsStore.onCoreStoppedTrigger().catch((err) => { // ✅ plugin hook fail OK
    console.warn('[kernelApi] onCoreStoppedTrigger error (ignored):', err)
  })
  coreStoppedResolver(null)                                // ✅ always reached
}
```

### 4. Add 15-second timeout and error handling to `stopCore`

```typescript
// Before
const stopCore = async () => {
  if (!running.value) throw 'The core is not running'
  stopping.value = true
  try {
    await pluginsStore.onBeforeCoreStopTrigger()
    await KillProcess(corePid.value)
    await (isCoreStartedByThisInstance ? coreStoppedPromise : onCoreStopped())
  } finally {
    stopping.value = false
  }
}

// After
const stopCore = async () => {
  if (!running.value) throw 'The core is not running'
  stopping.value = true
  try {
    await pluginsStore.onBeforeCoreStopTrigger().catch((err) => {  // ✅ plugin hook fail OK
      console.warn('[kernelApi] onBeforeCoreStopTrigger error (ignored):', err)
    })
    await KillProcess(corePid.value).catch((err) => {              // ✅ kill fail OK
      console.warn('[kernelApi] KillProcess error (ignored):', err)
    })
    // ✅ 15-second timeout prevents coreStoppedPromise hanging forever
    const stopWait = isCoreStartedByThisInstance ? coreStoppedPromise : onCoreStopped()
    await withTimeout(stopWait, 15000, 'waiting for core to stop').catch(async (err) => {
      console.warn('[kernelApi] stopCore wait timeout or error, forcing cleanup:', err)
      await onCoreStopped().catch(() => {})  // ✅ force cleanup to unfreeze GUI
    })
  } finally {
    stopping.value = false
  }
}
```

## Timeout Rationale

| Timeout | Reason |
|---------|--------|
| 30s (startup) | Normal sing-box start with rule-set download < 10s; 30s covers edge cases |
| 15s (stop) | SIGTERM exit normally < 1s; 15s covers slow network/plugin scenarios |

## Version Update Checklist

After upstream merges, verify in `frontend/src/stores/kernelApi.ts`:

- [ ] `runCoreProcess` has `Date.now() - startTime > maxStartupWait` check
- [ ] `onCoreStopped` has `.catch(() => {})` on `RemoveFile`, `updateSystemProxyStatus`, `onCoreStoppedTrigger`
- [ ] `onCoreStopped` includes `isCoreStartedByThisInstance = false`
- [ ] `stopCore` uses `withTimeout(stopWait, 15000, ...)` instead of raw `await coreStoppedPromise`
- [ ] `withTimeout` utility function exists

Search patterns to confirm fix:

```typescript
// 1. Startup timeout
const maxStartupWait = 30000

// 2. withTimeout function
const withTimeout = <T>(promise: Promise<T>, ms: number, label: string)

// 3. Stop timeout
await withTimeout(stopWait, 15000, 'waiting for core to stop')

// 4. State reset
isCoreStartedByThisInstance = false
```

## Testing Scenarios

**Scenario 1: Config error during stop/restart**
1. Create invalid config (e.g., urltest with `outbounds: []`)
2. Try to start → should error within 30s, `starting` state recovers
3. Click stop → should respond normally, no freeze

**Scenario 2: Normal stop flow**
1. Start core normally
2. Click stop → completes in seconds, `stopping` state recovers

**Scenario 3: Plugin hook exception**
1. Install test plugin with failing `onBeforeCoreStop` / `onCoreStopped`
2. Stop core → console shows `[kernelApi]` warning but GUI does not freeze

## Impact

- **File**: `frontend/src/stores/kernelApi.ts`
- **Functions**: Core start, stop, restart
- **Risk**: Low — only adds timeout guards and error handling, normal flow logic unchanged
- **Compatibility**: Fully backward compatible
