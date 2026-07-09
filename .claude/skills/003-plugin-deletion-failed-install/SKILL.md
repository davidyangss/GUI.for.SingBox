---
name: "plugin-deletion-failed-install"
description: "处理插件安装失败后无法删除的问题。当删除插件时报 'no such file or directory' 错误、安装失败的插件卡在列表中无法移除时调用此 skill。"
---

# Plugin Deletion Failed Install Fix

Use this skill when working in `GUI.for.SingBox` and the user encounters:

- 删除插件时报错 `open .../plugin-xxx.js: no such file or directory`
- 安装失败的插件无法从列表中删除
- 插件文件已不存在但插件配置仍残留

## Root Cause

**File**: `frontend/src/stores/plugins.ts` — `deletePlugin` function

When deleting a plugin, lifecycle events are triggered which call `loadPluginModule()` → `ReadFile(cache.plugin.path)`. If the plugin file does not exist (failed install), the read throws and the entire delete flow aborts.

Three call sites are unprotected:

1. `runPluginEvent(id, PluginTriggerEvent.OnDisabled, ...)` 
2. `disposePluginInstance(id)`
3. `runPluginEvent(id, PluginTriggerEvent.OnUninstall, ...)`

## Fix

Add `.catch(() => {})` to all three call sites in `deletePlugin` (~line 458–493):

```typescript
// Before
await runPluginEvent(id, PluginTriggerEvent.OnDisabled, [], {
  allowDisabled: true,
  allowUndefined: true,
})

await disposePluginInstance(id)
await runPluginEvent(id, PluginTriggerEvent.OnUninstall, [], {
  allowDisabled: true,
  allowUndefined: true,
})

// After
await runPluginEvent(id, PluginTriggerEvent.OnDisabled, [], {
  allowDisabled: true,
  allowUndefined: true,
}).catch(() => {})

await disposePluginInstance(id).catch(() => {})
await runPluginEvent(id, PluginTriggerEvent.OnUninstall, [], {
  allowDisabled: true,
  allowUndefined: true,
}).catch(() => {})
```

## Version Update Checklist

After upstream merges, verify in `frontend/src/stores/plugins.ts`:

- [ ] `deletePlugin` function still exists
- [ ] `runPluginEvent(...OnDisabled...)` has `.catch(() => {})`
- [ ] `disposePluginInstance(id)` has `.catch(() => {})`
- [ ] `runPluginEvent(...OnUninstall...)` has `.catch(() => {})`

Search patterns to confirm fix is applied:

```typescript
runPluginEvent(id, PluginTriggerEvent.OnDisabled
runPluginEvent(id, PluginTriggerEvent.OnUninstall
disposePluginInstance(id)
```

## Impact

- **File**: `frontend/src/stores/plugins.ts`
- **Risk**: Low — only adds error handling, normal flow unchanged
- **Compatibility**: Fully backward compatible
