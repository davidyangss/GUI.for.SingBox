---
name: "singbox-import-client-config"
description: "Adds 'Import Client Config' feature to import sing-box client-config.json as subscription + profile, and fixes orphan subscription JSON fallback in config generation. Invoke when syncing upstream and reapplying this feature patch."
---

# Feature: Import Client Config + Orphan Subscription Fallback

## Purpose

This feature solves two related problems:

1. **Import Client Config**: Users with a standalone sing-box `client-config.json` (e.g., from VPS setup scripts) cannot easily import it into GUI.for.SingBox. The GUI manages subscriptions and profiles separately, requiring manual creation of both.

2. **Orphan Subscription Bug**: When a subscription JSON file exists at `data/subscribes/ID_xxx.json` but has no entry in `data/subscribes.yaml`, the config generator produces empty-shell outbounds (only `type` + `tag`, missing `server`, `tls`, `uuid`, etc.), causing `FATAL: TLS required` at startup.

## Feature Overview

### Part 1: Import Client Config Modal

A new modal dialog accessible from both SubscribesView and ProfilesView, allowing users to:

- **Paste JSON** directly, or provide a **file path** to the client config
- Automatically extract proxy outbounds (vless, vmess, trojan, shadowsocks, hysteria2, etc.)
- Create a **Manual subscription** with the extracted proxies saved to `data/subscribes/{id}.json`
- Create a **Profile** restored from the full config (inbounds, outbounds, route rules, DNS servers) using `restoreProfile()`
- Link the subscription to the profile's selector/urltest outbounds

### Part 2: Orphan Subscription Fallback

In `generateOutbounds()`, when `subscribesStore.getSubscribeById(subId)` returns `undefined`, the code now scans `data/subscribes/` directory for a JSON file matching the subId, reads it directly, and caches the proxies. This ensures orphan subscription files work correctly even without a `subscribes.yaml` entry.

## Files Changed

### New File (1)

| File | Description |
|------|-------------|
| `frontend/src/views/SubscribesView/components/ImportClientConfig.vue` | Modal form component for importing client configs |

### Modified Files (5)

| File | Change Summary |
|------|----------------|
| `frontend/src/views/SubscribesView/index.vue` | Added Import button in header and empty state; imported `ImportClientConfig` component |
| `frontend/src/views/ProfilesView/index.vue` | Added Import button in header and empty state; imported `ImportClientConfig` component |
| `frontend/src/utils/generator.ts` | Added `ReadDir` import; added `_resolveOrphanSubscription()` function; added orphan fallback in `generateOutbounds()`; replaced unsafe `!` assertions with safe `continue` guard |
| `frontend/src/lang/locale/en.ts` | Added `importClientConfig` i18n section (16 keys) |
| `frontend/src/lang/locale/zh.ts` | Added `importClientConfig` i18n section (16 keys, Chinese) |

## Detailed Changes

### 1. ImportClientConfig.vue

**Location**: `frontend/src/views/SubscribesView/components/ImportClientConfig.vue`

**Key logic flow**:

```
User provides config (paste JSON or file path)
  → parseConfig(): JSON.parse + validate
  → extractProxies(): filter outbounds by ProxyOutboundTypes list
  → subscribeStore.getSubscribeTemplate() → set type='Manual'
  → addSubscribe() → WriteFile(proxies JSON) → updateSubscribe()
  → restoreProfile(config, name, { subscriptionIds: [sub.id] })
  → Link subscription to selector/urltest outbounds
  → profilesStore.addProfile(profile)
```

**ProxyOutboundTypes** recognized as proxy nodes:

```
vless, vmess, trojan, shadowsocks, shadowsocksr,
hysteria, hysteria2, tuic, wireguard, ssh, socks, http
```

**Non-proxy types filtered out**: `direct`, `block`, `selector`, `urltest`, `dns`

### 2. SubscribesView/index.vue Changes

```vue
<!-- Import added to script section -->
import ImportClientConfig from './components/ImportClientConfig.vue'

<!-- Handler function added -->
const handleImportClientConfig = () => {
  modalApi.setProps({
    title: 'importClientConfig.title',
    minWidth: '70',
  })
  modalApi.setContent(ImportClientConfig, {}).open()
}

<!-- Button in header (next to Update All / Add) -->
<Button type="link" @click="handleImportClientConfig">
  {{ t('common.import') }}
</Button>

<!-- Button in empty state -->
<Button type="link" @click="handleImportClientConfig">
  {{ t('importClientConfig.title') }}
</Button>
```

### 3. ProfilesView/index.vue Changes

Same pattern as SubscribesView — imports the component from its cross-view path:

```vue
import ImportClientConfig from '@/views/SubscribesView/components/ImportClientConfig.vue'
```

Adds the same `handleImportClientConfig` handler and Import buttons in both header and empty state.

### 4. generator.ts — Orphan Subscription Fallback

**New import**:

```ts
import { ReadFile, ReadDir, WriteFile } from '@/bridge'
```

**New function** `_resolveOrphanSubscription` (before `generateOutbounds`):

```ts
const _resolveOrphanSubscription = async (
  subId: string,
  orphanCache: Recordable<any[]>,
): Promise<any[] | undefined> => {
  if (orphanCache[subId]) return orphanCache[subId]
  try {
    const files = await ReadDir('data/subscribes')
    const file = files.find((f) => f.name === subId + '.json')
    if (!file) return undefined
    const content = await ReadFile('data/subscribes/' + file.name)
    const proxies = JSON.parse(content)
    if (!Array.isArray(proxies) || proxies.length === 0) return undefined
    orphanCache[subId] = proxies
    return proxies
  } catch {
    return undefined
  }
}
```

**Modified `generateOutbounds`** — key changes:

1. Added `const orphanCache: Recordable<any[]> = {}` alongside `SubscriptionCache`
2. After `getSubscribeById` fails, added `else` branch calling `_resolveOrphanSubscription`
3. Replaced unsafe `SubscriptionCache[subId]!` with safe pattern:

```ts
// BEFORE (buggy):
if (proxy.type === 'Subscription') {
  _outbound.outbounds.push(
    ...SubscriptionCache[subId]!.map((v) => v.tag).filter(...)
  )
}

// AFTER (fixed):
const cached = SubscriptionCache[subId]
if (!cached) continue
if (proxy.type === 'Subscription') {
  _outbound.outbounds.push(
    ...cached.map((v) => v.tag).filter(...)
  )
}
```

### 5. i18n Translations

Added `importClientConfig` section in both `en.ts` and `zh.ts`:

```ts
importClientConfig: {
  title: 'Import Client Config',          // 导入客户端配置
  inputMode: 'Input Mode',                // 输入方式
  paste: 'Paste JSON',                    // 粘贴JSON
  file: 'File Path',                      // 文件路径
  filePath: 'File Path',                  // 文件路径
  filePathPlaceholder: 'e.g. /path/...',  // 例如 /path/to/client-config.json
  pastePlaceholder: '...',               // 请在下方粘贴...
  jsonPlaceholder: '{...}',              // JSON 示例模板
  invalidConfig: '...',                  // 无效的 JSON 配置
  noOutbounds: '...',                    // 配置中未找到出站
  noProxyOutbounds: '...',              // 配置中未找到代理出站
  filePathRequired: '...',              // 请输入文件路径
  contentRequired: '...',               // 请输入 JSON 内容
  success: '...',                        // 客户端配置导入成功
}
```

## How to Reapply After Upstream Sync

When syncing a new upstream version of GUI.for.SingBox, check each file:

### Check 1: ImportClientConfig.vue

```bash
test -f frontend/src/views/SubscribesView/components/ImportClientConfig.vue
```

If missing, recreate from the patch above.

### Check 2: SubscribesView/index.vue

Look for the Import button and `handleImportClientConfig` handler. If upstream removed them, re-add:
- Import: `import ImportClientConfig from './components/ImportClientConfig.vue'`
- Handler: `handleImportClientConfig()` function
- Buttons: in both `grid-list-header` and `grid-list-empty` sections

### Check 3: ProfilesView/index.vue

Same checks as SubscribesView. The import path is cross-view:
```ts
import ImportClientConfig from '@/views/SubscribesView/components/ImportClientConfig.vue'
```

### Check 4: generator.ts

Look for `_resolveOrphanSubscription` function. If upstream removed it:
1. Add `ReadDir` to the import from `@/bridge`
2. Add `_resolveOrphanSubscription` function before `generateOutbounds`
3. In `generateOutbounds`, add `orphanCache` variable and `else` branch for orphan fallback
4. Replace `SubscriptionCache[subId]!` with safe `const cached = ...; if (!cached) continue`

### Check 5: i18n files

Search for `importClientConfig` section in `en.ts` and `zh.ts`. If missing, re-add the full section.

## Verification

After reapplying, run:

```bash
cd frontend
pnpm run type-check   # vue-tsc --build
pnpm run build-only   # vite build
pnpm run lint         # oxlint + eslint
```

All three must pass with 0 errors.

## Design Decisions

1. **Manual subscription type**: The imported subscription uses `type: 'Manual'` which means it won't auto-update from a URL — the user manages the proxies manually through the GUI's proxy editor.

2. **restoreProfile integration**: Uses the existing `restoreProfile()` utility from `@/utils/restorer.ts` to convert raw sing-box config into GUI's internal profile format (IProfile), preserving inbounds, route rules, DNS servers, etc.

3. **Orphan fallback is non-intrusive**: `_resolveOrphanSubscription` only triggers when `getSubscribeById` fails, and gracefully returns `undefined` on any error. The `continue` guard prevents crashes from null cache entries.

4. **Cross-view component reuse**: `ImportClientConfig.vue` lives in SubscribesView but is imported by ProfilesView via absolute path. This follows the project's pattern of shared modal components.

## Bug Fixes During Development

The following bugs were discovered and fixed during development:

### Bug 1: vue-i18n Placeholder Interpolation Error

**Symptom**: When opening the Import dialog with "Paste JSON" mode, a console error appeared:

```
SyntaxError: Message compilation error: Invalid token in placeholder: '"log":'
```

**Root Cause**: The `jsonPlaceholder` i18n key contained literal `{` and `}` characters from the JSON template string. Vue I18n interpreted these as interpolation placeholders and failed to parse them.

**Fix**: Replaced the JSON template string in both `en.ts` and `zh.ts` with plain descriptive text:

```ts
// BEFORE (caused error):
jsonPlaceholder: '{\n  "log": { ... },\n  "dns": { ... },\n  "inbounds": [ ... ],\n  "outbounds": [ ... ],\n  "route": { ... }\n}',

// AFTER (works):
jsonPlaceholder: 'Paste full sing-box client config JSON here...',
// Chinese:
jsonPlaceholder: '在此粘贴完整的 sing-box 客户端配置 JSON...',
```

**Location**: `frontend/src/lang/locale/en.ts` line ~509, `frontend/src/lang/locale/zh.ts` line ~447

---

### Bug 2: restoreExperimental Crash on Missing `experimental` Field

**Symptom**: After clicking Import, an unhandled promise rejection appeared:

```
TypeError: undefined is not an object (evaluating 'raw.clash_api')
at restoreExperimental (restorer.ts:117)
at restoreProfile (restorer.ts:67)
```

**Root Cause**: The `client-config.json` being imported does not have an `experimental` block (it only contains `log`, `dns`, `inbounds`, `outbounds`, `route`). When `restoreProfile()` calls `restoreExperimental(config.experimental, OutboundsIds)` with `undefined`, the function's `deepAssign(template, raw)` returned `undefined` for `clash_api`. Then accessing `raw.clash_api?.external_ui_download_detour` crashed because `raw` itself was `undefined`.

**Fix**: Added early return guard in `restoreExperimental`:

```ts
const restoreExperimental = (raw: Recordable, OutboundsIds: Recordable): IExperimental => {
  const template = Defaults.DefaultExperimental()
  if (!raw) return template  // ← Early return: prevents crash when experimental is missing
  const experimental = deepAssign(template, raw)
  // Safe access after ensuring both experimental.clash_api and raw.clash_api exist
  if (experimental.clash_api && raw.clash_api) {
    experimental.clash_api.external_ui_download_detour =
      OutboundsIds[raw.clash_api.external_ui_download_detour] || ''
  } else {
    experimental.clash_api = {}
  }
  return experimental
}
```

**Location**: `frontend/src/utils/restorer.ts` lines 113-124

**Why this is important**: Many standalone sing-box configs are minimal — they may lack `experimental`, `log.level`, etc. The `restoreProfile()` function relies on `Defaults.DefaultExperimental()` providing sensible defaults, so `restoreExperimental` must handle missing input gracefully without crashing.

---

### Bug 3: Vite HMR Module Cache Stale

**Symptom**: After fixing Bug 2, the crash persisted even though the source file showed the correct code. Vite Hot Module Replacement triggered `page reload src/utils/restorer.ts` but the old module was still executing in the running App instance.

**Root Cause**: Wails dev uses Vite's DevServer as a separate process from the Go backend. When restorer.ts was edited in-place, Vite reloaded the module, but the running App window's JavaScript VM retained the old compiled version until the next navigation event. Since the import handler runs synchronously inside the modal lifecycle, it picked up the stale code.

**Fix**: Full restart of `wails dev`:

```bash
pkill -f "wails dev"
rm -rf build/bin/GUI.for.SingBox.app  # Clear cached app bundle
wails dev
```

This forces Vite to recompile all modules fresh and the Go backend to rebuild the entire binary.

**Lesson learned**: For critical changes to utility modules that are loaded at App startup (like `restorer.ts`, `generator.ts`, stores), always do a full `wails dev` restart rather than relying on HMR.

---

### Bug 4: macOS Codesign Failure Blocking Build

**Symptom**: Every `wails dev` start failed with:

```
Build error - codesign failed: exit status 1
In subcomponent: GUI.for.SingBox.app/Contents/MacOS/data/.cache
```

**Root Cause**: The `data/.cache` directory (which stores downloaded plugin lists, ruleset lists, icons, etc.) gets bundled into the app binary during each build. This directory contains non-code files (`.ico`, `.png`) that confuse codesign's format detection.

**Fix**: Clean the `.cache` before rebuilding:

```bash
rm -rf build/bin/GUI.for.SingBox.app/Contents/MacOS/data/.cache
```

Or fully clean and rebuild:

```bash
rm -rf build/bin/GUI.for.SingBox.app
wails dev
```

This is a known quirk of GUI.for.SingBox's build system — the cache directory should never be committed or bundled. On upstream sync, ensure the build cache is cleaned first.
