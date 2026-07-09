# 03-核心停止/重启卡死修复 (Kernel Stop/Restart Freeze Fix)

## 问题描述 (Issue Description)

当 sing-box 配置文件存在错误（如 `outbounds: []` 空列表、`missing tags` 等），或进程异常崩溃时，GUI 的停止/重启核心操作会永久卡死，按钮无法再次点击，必须强制退出 GUI。

典型触发场景：
- sing-box 启动时立即报 `FATAL[0000] create service: initialize outbound[N]: missing tags`
- 插件的 `onBeforeCoreStop` / `onCoreStopped` 钩子执行超时或抛出异常
- `KillProcess` 对已崩溃的进程操作失败
- GUI 重启后 pid.txt 残留，`isCoreStartedByThisInstance` 状态不一致

## 根本原因 (Root Cause)

**文件位置**: `frontend/src/stores/kernelApi.ts`

### 原因1：`runCoreProcess` 的 probe 循环无超时保护

```typescript
while (!stopped) {
  const ok = await probeApiAvailability().catch(() => false)
  if (ok) break
  if (stopped) throw 'Startup failed. Check logs for details.'
  await sleep(500)
}
```

`stopped` 由进程退出的异步回调设置。若网络抖动或 sing-box 进程卡住（既不启动成功也不退出），循环会无限运行，`starting.value` 永远不会被 `finally` 重置。

### 原因2：`stopCore` 的 `coreStoppedPromise` 无超时

```typescript
await (isCoreStartedByThisInstance ? coreStoppedPromise : onCoreStopped())
```

`coreStoppedPromise` 只有在 `onCoreStopped()` 执行完毕并调用 `coreStoppedResolver(null)` 后才 resolve。若 `pluginsStore.onCoreStoppedTrigger()` 挂起，promise 永不 resolve，`stopping.value = true` 永远无法被 `finally` 重置，按钮卡死。

### 原因3：`onCoreStopped` 中的异步操作未防御

```typescript
await RemoveFile(CorePidFilePath)      // 若文件不存在则抛出
await envStore.updateSystemProxyStatus() // 若系统调用失败则抛出
await pluginsStore.onCoreStoppedTrigger() // 若插件卡住则挂起
coreStoppedResolver(null)              // 上面任一失败则永不执行
```

### 原因4：`isCoreStartedByThisInstance` 未在 `onCoreStopped` 中重置

导致下一次启动时状态错乱，`stopCore` 选择错误的等待路径。

## 修复方案 (Fix Solution)

**文件位置**: `frontend/src/stores/kernelApi.ts`

### 修改1：`runCoreProcess` 添加 30 秒启动超时

```typescript
// 修改前
while (!stopped) {
  const ok = await probeApiAvailability().catch(() => false)
  if (ok) break
  if (stopped) throw 'Startup failed. Check logs for details.'
  await sleep(500)
}

// 修改后
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

### 修改2：新增 `withTimeout` 工具函数

添加在 `onCoreStopped` 定义之前：

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

### 修改3：`onCoreStopped` 全面防御化

```typescript
// 修改前
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

// 修改后
const onCoreStopped = async () => {
  if (!isCoreStartedByThisInstance) {
    await RemoveFile(CorePidFilePath).catch(() => {})      // ✅ 文件不存在时不抛出
  }
  corePid.value = -1
  running.value = false
  isCoreStartedByThisInstance = false                      // ✅ 确保状态正确重置
  needRestart.value = false
  destroyWebsocket()
  await envStore.updateSystemProxyStatus().catch(() => {}) // ✅ 系统调用失败时不阻塞
  if (envStore.systemProxy) {
    await envStore.clearSystemProxy().catch((err) => message.error(err))
  }
  if (appSettingsStore.app.autoSetSystemDNS || envStore.systemDNSSet) {
    await envStore.setSystemDNS(false).catch((err) => message.error(err))
  }
  resetConfig()
  await pluginsStore.onCoreStoppedTrigger().catch((err) => { // ✅ 插件钩子失败不阻塞
    console.warn('[kernelApi] onCoreStoppedTrigger error (ignored):', err)
  })
  coreStoppedResolver(null)                                // ✅ 始终执行
}
```

### 修改4：`stopCore` 添加 15 秒超时并捕获插件/Kill 错误

```typescript
// 修改前
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

// 修改后
const stopCore = async () => {
  if (!running.value) throw 'The core is not running'
  stopping.value = true
  try {
    await pluginsStore.onBeforeCoreStopTrigger().catch((err) => {  // ✅ 插件钩子失败不阻塞
      console.warn('[kernelApi] onBeforeCoreStopTrigger error (ignored):', err)
    })
    await KillProcess(corePid.value).catch((err) => {              // ✅ Kill 失败不阻塞
      console.warn('[kernelApi] KillProcess error (ignored):', err)
    })
    // ✅ 15 秒超时兜底，防止 coreStoppedPromise 永不 resolve
    const stopWait = isCoreStartedByThisInstance ? coreStoppedPromise : onCoreStopped()
    await withTimeout(stopWait, 15000, 'waiting for core to stop').catch(async (err) => {
      console.warn('[kernelApi] stopCore wait timeout or error, forcing cleanup:', err)
      await onCoreStopped().catch(() => {})  // ✅ 强制清理，解除 GUI 卡死
    })
  } finally {
    stopping.value = false
  }
}
```

## 版本更新检查清单 (Version Update Checklist)

### ✅ 必须检查项

- [ ] `runCoreProcess` 的 `while (!stopped)` 循环内是否有超时判断（`Date.now() - startTime > 30000`）
- [ ] `onCoreStopped` 中 `RemoveFile`、`updateSystemProxyStatus`、`onCoreStoppedTrigger` 是否都有 `.catch()`
- [ ] `onCoreStopped` 中是否包含 `isCoreStartedByThisInstance = false`
- [ ] `stopCore` 中是否使用 `withTimeout(stopWait, 15000, ...)` 而不是直接 `await coreStoppedPromise`
- [ ] `withTimeout` 工具函数是否存在于 `kernelApi.ts` store 内

### 🔍 关键代码位置

搜索以下特征模式确认修复已应用：

```typescript
// 1. 启动超时
const maxStartupWait = 30000

// 2. withTimeout 函数
const withTimeout = <T>(promise: Promise<T>, ms: number, label: string)

// 3. stopCore 中的超时等待
await withTimeout(stopWait, 15000, 'waiting for core to stop')

// 4. onCoreStopped 中状态重置
isCoreStartedByThisInstance = false
```

### 🧪 测试验证

**场景1：配置错误时停止/重启**
1. 故意制造无效配置（如 `outbounds: []` 的 urltest）
2. 尝试启动核心 → 应在 30 秒内报错，`starting` 状态恢复
3. 再次点击停止 → 应正常响应，不卡死

**场景2：正常停止流程**
1. 正常启动核心
2. 点击停止 → 应在几秒内完成，`stopping` 状态恢复

**场景3：插件钩子异常**
1. 安装一个 `onBeforeCoreStop` / `onCoreStopped` 会抛出异常的测试插件
2. 停止核心 → 控制台应有 `[kernelApi]` 警告，但 GUI 不卡死

## 影响范围 (Impact Scope)

- **影响文件**: `frontend/src/stores/kernelApi.ts`
- **影响功能**: 核心启动、停止、重启
- **风险等级**: 低（仅添加超时保护和错误捕获，不改变正常流程逻辑）
- **兼容性**: 完全向后兼容

## 修复日期 (Fix Date)

- **修复日期**: 2026-07-09
- **版本**: 当前开发版本
- **修复人**: Kiro AI

## 备注 (Notes)

超时时间选择依据：
| 超时 | 说明 |
|------|------|
| 30s（启动超时） | sing-box 正常启动含规则集下载，通常 < 10s；30s 留有充裕余量 |
| 15s（停止超时） | 进程收到 SIGTERM 后正常退出 < 1s；15s 覆盖极端网络/插件慢的情况 |
