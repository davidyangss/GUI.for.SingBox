# 01-插件删除错误处理 (Plugin Deletion Error Handling)

## 问题描述 (Issue Description)

当插件安装失败后，插件文件不存在，但尝试删除插件时会报错：

```
Speedtest CLI : open /Applications/GUl.for.SingBox.app/Contents/MacOS/data/plugins/plugin-speedtest-cli.js: no such file or directory
```

这导致安装失败的插件无法被删除。

## 根本原因 (Root Cause)

在 `frontend/src/stores/plugins.ts` 的 `deletePlugin` 函数中：

1. 删除插件时会调用 `runPluginEvent()` 触发生命周期事件（OnDisabled, OnUninstall）
2. `runPluginEvent()` 会调用 `loadPluginModule()` 加载插件模块
3. `loadPluginModule()` 尝试读取插件文件：`await ReadFile(cache.plugin.path)`
4. 如果插件文件不存在（安装失败），读取失败并抛出错误
5. 错误未被捕获，导致删除流程中断

## 修复方案 (Fix Solution)

**文件位置**: `frontend/src/stores/plugins.ts`

**修改位置**: `deletePlugin` 函数 (约第 458-493 行)

### 修改内容

在以下三处调用添加 `.catch(() => {})` 错误处理：

1. **OnDisabled 事件** (行 466-469)
2. **disposePluginInstance** (行 472)  
3. **OnUninstall 事件** (行 473-476)

### 修改前代码

```typescript
const deletePlugin = async (id: string) => {
  const idx = plugins.value.findIndex((v) => v.id === id)
  if (idx === -1) return
  const plugin = plugins.value[idx]!

  ensurePluginRuntimeCache(plugin)

  if (!plugin.disabled) {
    await runPluginEvent(id, PluginTriggerEvent.OnDisabled, [], {
      allowDisabled: true,
      allowUndefined: true,
    })
  }

  await disposePluginInstance(id)
  await runPluginEvent(id, PluginTriggerEvent.OnUninstall, [], {
    allowDisabled: true,
    allowUndefined: true,
  })

  plugins.value.splice(idx, 1)
  // ... 剩余代码
}
```

### 修改后代码

```typescript
const deletePlugin = async (id: string) => {
  const idx = plugins.value.findIndex((v) => v.id === id)
  if (idx === -1) return
  const plugin = plugins.value[idx]!

  ensurePluginRuntimeCache(plugin)

  if (!plugin.disabled) {
    await runPluginEvent(id, PluginTriggerEvent.OnDisabled, [], {
      allowDisabled: true,
      allowUndefined: true,
    }).catch(() => {})  // ✅ 添加错误捕获
  }

  await disposePluginInstance(id).catch(() => {})  // ✅ 添加错误捕获
  await runPluginEvent(id, PluginTriggerEvent.OnUninstall, [], {
    allowDisabled: true,
    allowUndefined: true,
  }).catch(() => {})  // ✅ 添加错误捕获

  plugins.value.splice(idx, 1)
  // ... 剩余代码
}
```

## 版本更新检查清单 (Version Update Checklist)

更新到新版本时，请检查以下内容：

### ✅ 必须检查项

- [ ] 确认 `frontend/src/stores/plugins.ts` 文件中的 `deletePlugin` 函数仍然存在
- [ ] 检查 `runPluginEvent` 调用是否仍包含 `.catch(() => {})` 错误处理
- [ ] 检查 `disposePluginInstance` 调用是否仍包含 `.catch(() => {})` 错误处理
- [ ] 验证错误处理逻辑未被移除或重构

### 🔍 关键代码位置

在 `deletePlugin` 函数中搜索以下模式：

```typescript
runPluginEvent(id, PluginTriggerEvent.OnDisabled
runPluginEvent(id, PluginTriggerEvent.OnUninstall
disposePluginInstance(id)
```

确保它们都有 `.catch(() => {})` 或等效的错误处理。

### 🧪 测试验证

1. **创建测试场景**：
   ```bash
   # 模拟插件安装失败：删除插件文件但保留插件配置
   # 然后尝试删除该插件
   ```

2. **预期结果**：
   - 插件可以成功删除
   - 不会抛出 "no such file or directory" 错误
   - 插件从列表中移除
   - 相关配置可选择性删除

### 📝 相关函数

如果以下函数被重构，需要重新评估修复方案：

- `deletePlugin` - 插件删除主函数
- `runPluginEvent` - 插件事件执行
- `loadPluginModule` - 插件模块加载
- `disposePluginInstance` - 插件实例销毁

## 影响范围 (Impact Scope)

- **影响文件**: `frontend/src/stores/plugins.ts`
- **影响功能**: 插件删除功能
- **风险等级**: 低（仅添加错误处理，不改变正常流程）
- **兼容性**: 完全向后兼容

## 修复日期 (Fix Date)

- **修复日期**: 2026-07-09
- **版本**: 当前开发版本
- **修复人**: Kiro AI

## 备注 (Notes)

此修复确保即使插件文件不存在（安装失败或手动删除），也能正常清理插件元数据和配置，提高系统健壮性。

错误处理采用静默捕获（`.catch(() => {})`），因为在删除场景下，生命周期事件的失败不应阻止删除操作的完成。
