---
name: "singbox-plugin-delete-missing-file"
description: "Fixes plugin deletion failure when plugin file is manually removed from data/plugins directory. Invoke when syncing upstream and reapplying the plugin deletion robustness patch, or when debugging plugin deletion issues."
---

# Fix Plugin Deletion When File Is Missing

## Problem

When a user manually deletes a plugin file from `data/plugins` directory, the UI cannot delete the plugin from the list. The `deletePlugin` function fails because:

1. `runPluginEvent` tries to load and execute plugin code for cleanup events (`OnDisabled`, `OnDispose`, `OnUninstall`)
2. `loadPluginModule` reads the plugin file which no longer exists
3. For `File` type plugins, it returns empty string `''`, but subsequent JavaScript module import fails
4. The error interrupts the deletion flow before `plugins.value.splice(idx, 1)` is executed
5. The plugin record remains in `plugins.yaml` and the UI list

## Location

File: `frontend/src/stores/plugins.ts`

Function: `deletePlugin` (around line 458)

## Fix

Wrap the event-triggering code in a `try-catch` block to ensure deletion continues even when plugin file is missing:

```typescript
const deletePlugin = async (id: string) => {
  const idx = plugins.value.findIndex((v) => v.id === id)
  if (idx === -1) return
  const plugin = plugins.value[idx]!

  try {
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
  } catch {
    console.warn(`[Plugin] Failed to run cleanup events for ${plugin.name}, file may be missing`)
  }

  plugins.value.splice(idx, 1)

  syncPluginObservers(plugin, false)
  releasePluginRuntimeCache(id)

  if (plugin.path.startsWith('data')) {
    await RemoveFile(plugin.path).catch((_) => {})
  }
  if (appSettingsStore.app.pluginSettings[plugin.id]) {
    if (await confirm('Tips', 'plugins.removeConfiguration').catch(() => 0)) {
      delete appSettingsStore.app.pluginSettings[plugin.id]
    }
  }

  await savePlugins()
}
```

## Key Changes

| Original | Fixed |
|----------|-------|
| Events run directly, errors abort deletion | Events wrapped in `try-catch`, deletion continues |
| Plugin remains in list if file missing | Plugin removed regardless of file status |
| Silent failure, user sees nothing | Console warning for debugging |

## Behavior After Fix

1. Attempt cleanup events (`OnDisabled`, `OnDispose`, `OnUninstall`)
2. If events fail (file missing), log warning and continue
3. Always execute `plugins.value.splice(idx, 1)` to remove from list
4. Remove plugin file (if exists) and configuration
5. Save `plugins.yaml`

## When to Apply This Patch

Apply when:
- Syncing a new upstream version that overwrites `plugins.ts`
- The `deletePlugin` function needs to be robustified again
- User reports plugin deletion not working after manual file removal

## Verification

After applying, test by:
1. Add a plugin to the list
2. Manually delete the plugin file from `data/plugins/`
3. Try to delete the plugin from UI
4. Verify plugin is removed from list and `plugins.yaml`