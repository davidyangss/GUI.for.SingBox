---
name: "singbox-builtin-proxy-convert"
description: "Integrates Sub-Store proxy-utils for built-in Clash/V2Ray format conversion. Invoke when syncing upstream and reapplying the built-in proxy format conversion patch, or when subscription import fails due to format mismatch."
---

# Built-in Proxy Format Conversion

Use this skill when updating `GUI.for.SingBox` to a new upstream version and you need to reapply the customization that integrates Sub-Store's proxy-utils conversion library into the application's core subscription handling logic.

## Goal

Make the app automatically convert various proxy formats to SingBox format without requiring the `plugin-node-convert` plugin:

- V2Ray Base64 sharing links → SingBox format
- Clash/Mihomo YAML format → SingBox format
- SingBox JSON format → unchanged
- Manual JSON format → unchanged

Additionally, ensure subscription servers return traffic information by using a compatible default User-Agent:

- Default `clash.meta` UA → triggers `Subscription-Userinfo` header for traffic stats
- Users can override UA in subscription settings

This eliminates the mandatory plugin dependency and allows direct subscription import with traffic info display.

## Files Usually Involved

- `frontend/src/utils/proxyUtils.ts` (new file)
- `frontend/src/stores/subscribes.ts`
- `frontend/public/proxy-utils.esm.mjs` (downloaded from Sub-Store releases)
- `frontend/.oxlintrc.json` (ignore third-party library)
- `frontend/eslint.config.js` (ignore third-party library)

## Required Behavior

1. Download Sub-Store's `proxy-utils.esm.mjs` to `frontend/public/`
2. Create `frontend/src/utils/proxyUtils.ts` wrapper module
3. Import and use conversion functions in `subscribes.ts`
4. Remove the hard error when non-SingBox format is detected
5. Add default `User-Agent: clash.meta` for subscription HTTP requests
6. Add lint ignore rules for the third-party library

## Implementation Steps

### 1. Download proxy-utils.esm.mjs

Download the latest release from Sub-Store:

```bash
curl -L -o frontend/public/proxy-utils.esm.mjs \
  https://github.com/sub-store-org/Sub-Store/releases/latest/download/proxy-utils.esm.mjs
```

Or use the specific version URL from GitHub API:

```bash
curl -L -o frontend/public/proxy-utils.esm.mjs \
  https://github.com/sub-store-org/Sub-Store/releases/download/2.23.1/proxy-utils.esm.mjs
```

### 2. Create proxyUtils.ts wrapper

Create `frontend/src/utils/proxyUtils.ts`:

```ts
let parseFunc: any = null
let produceFunc: any = null
let moduleLoaded = false

const loadModule = async () => {
  if (moduleLoaded) return
  try {
    const moduleUrl = '/proxy-utils.esm.mjs'
    const module = await import(moduleUrl)
    parseFunc = module.parse
    produceFunc = module.produce
    moduleLoaded = true
  } catch (error) {
    console.error('[proxyUtils] Failed to load proxy-utils module:', error)
    throw error
  }
}

export const parseProxies = async (input: string) => {
  await loadModule()
  if (!parseFunc) {
    throw new Error('parse function not available')
  }
  return parseFunc(input)
}

export const produceProxies = async (
  proxies: Record<string, any>[],
  targetFormat: 'singbox' | 'v2ray' | 'clash' = 'singbox',
  targetPlatform: 'internal' | 'external' = 'internal'
) => {
  await loadModule()
  if (!produceFunc) {
    throw new Error('produce function not available')
  }
  return produceFunc(proxies, targetFormat, targetPlatform)
}

export const convertToSingBox = async (proxies: Record<string, any>[]) => {
  const isClashFormat = proxies.some((proxy) => proxy.name && !proxy.tag)
  if (!isClashFormat) {
    return proxies
  }
  const converted = await produceProxies(proxies, 'singbox', 'internal')
  converted.forEach((proxy: Record<string, any>) => {
    delete proxy.domain_resolver
  })
  return converted
}

export const isBase64Format = (proxies: Record<string, any>[]) => {
  return proxies.length === 1 && proxies[0]?.base64
}

export const isClashFormat = (proxies: Record<string, any>[]) => {
  return proxies.some((proxy) => proxy.name && !proxy.tag)
}
```

### 3. Update subscribes.ts

In `frontend/src/stores/subscribes.ts`:

**Add imports:**

```ts
import {
  parseProxies,
  convertToSingBox,
  isBase64Format,
  isClashFormat,
} from '@/utils/proxyUtils'
```

**Replace the hard error with conversion logic:**

Find the section after subscription parsing (around line 133-145):

```ts
// OLD CODE (remove this):
if (proxies.some((proxy) => proxy.name && !proxy.tag) || proxies[0]?.base64) {
  throw 'You need to install the [节点转换] plugin first'
}
```

Replace with:

```ts
// NEW CODE:
try {
  if (isBase64Format(proxies) && proxies[0]?.base64) {
    proxies = await parseProxies(proxies[0].base64)
  }
  if (isClashFormat(proxies)) {
    proxies = await convertToSingBox(proxies)
  }
} catch (error) {
  console.warn('[Subscribes] Built-in conversion failed, trying plugin:', error)
}

// After plugin trigger, change hard error to warning:
if (proxies.some((proxy) => proxy.name && !proxy.tag) || proxies[0]?.base64) {
  console.warn('[Subscribes] Non-sing-box format detected, plugin may handle conversion')
}
```

The conversion should happen **before** the plugin `onSubscribeTrigger` call, so plugins can still process converted proxies if needed.

### 4. Add default User-Agent for subscription requests

To ensure subscription servers return traffic information (`Subscription-Userinfo` header) and proper format, add a default User-Agent in the HTTP request section.

Find the subscription request section (around line 101-112):

```ts
// OLD CODE:
if (s.type === 'Http') {
  const { headers: h, body: b } = await Requests({
    method: s.requestMethod,
    url: s.url,
    headers: s.header.request,
    autoTransformBody: false,
    options: {
      Insecure: s.inSecure,
      Timeout: s.requestTimeout,
    },
  })
```

Replace with:

```ts
// NEW CODE:
if (s.type === 'Http') {
  const defaultUA = 'clash.meta'
  const requestHeaders = {
    'User-Agent': s.header.request['User-Agent'] || defaultUA,
    ...s.header.request,
  }
  const { headers: h, body: b } = await Requests({
    method: s.requestMethod,
    url: s.url,
    headers: requestHeaders,
    autoTransformBody: false,
    options: {
      Insecure: s.inSecure,
      Timeout: s.requestTimeout,
    },
  })
```

This ensures:
- **Default**: `clash.meta` UA → most servers return traffic info + Clash format
- **User override**: If user sets `User-Agent` in subscription request headers, use that value instead
- **Traffic info**: `Subscription-Userinfo` header will be parsed correctly

### 5. Add lint ignore rules

In `frontend/.oxlintrc.json`, add:

```json
{
  "ignorePatterns": ["public/proxy-utils.esm.mjs"]
}
```

In `frontend/eslint.config.js`, add to the `globalIgnores` array:

```js
globalIgnores(['**/dist/**', '**/wailsjs/**', 'public/proxy-utils.esm.mjs']),
```

## Conversion Logic Flow

1. **Subscription fetch** → HTTP request with `User-Agent: clash.meta` (default)
2. **Response headers** → Parse `Subscription-Userinfo` for traffic stats (upload/download/total/expire)
3. **Body parsing** → raw body (YAML/JSON/Base64)
4. **Format detection**:
   - `isValidSubJson()` → SingBox `outbounds`
   - `isValidSubYAML()` → Clash `proxies`
   - `isValidBase64()` → V2Ray links wrapped as `[{ base64: body }]`
5. **Built-in conversion** (new step):
   - Base64 → `parseProxies()` → Clash format
   - Clash → `convertToSingBox()` → SingBox format
6. **Plugin processing** → plugins can still modify
7. **Final check** → warning (not hard error)

## Supported Formats

| Format | Detection | Conversion |
|--------|-----------|------------|
| SingBox JSON | `outbounds` field, nodes have `tag` | None |
| Clash/Mihomo YAML | `proxies` field, nodes have `name` without `tag` | Clash → SingBox |
| V2Ray Base64 | Single `base64` property | Base64 → Clash → SingBox |
| Manual JSON | Direct JSON array | None |

## Supported Protocols

The Sub-Store `proxy-utils` library handles:

- Shadowsocks / ShadowsocksR
- VMess / VLESS
- Trojan
- Hysteria / Hysteria2
- TUIC
- WireGuard
- HTTP / HTTPS / SOCKS

## Validation Checklist

After applying the patch:

1. Run diagnostics:
   - `pnpm type-check` (TypeScript)
   - `pnpm lint` (ESLint + Oxlint)
2. Confirm no new lint or type errors appear.
3. Verify the conversion logic order:
   - Built-in conversion runs **before** plugin trigger
   - Plugin can still process converted proxies
4. Verify User-Agent logic:
   - Default UA is `clash.meta`
   - User's custom UA in request headers is respected
5. Test subscription import:
   - Clash format URL should import without plugin
   - V2Ray Base64 URL should import without plugin
   - SingBox JSON URL should import unchanged
6. Test traffic info display:
   - Subscription should show upload/download/total/expire
   - If server provides `Subscription-Userinfo` header

## Search Hints

If upstream moved code around, search for:

- `isValidBase64(body)`
- `isValidSubYAML(body)`
- `isValidSubJson(body)`
- `pluginStore.onSubscribeTrigger`
- `'You need to install the [节点转换] plugin first'`
- `proxies.some((proxy) => proxy.name && !proxy.tag)`
- `Subscription-Userinfo`
- `s.header.request` (subscription request headers)
- `Requests({` (HTTP request for subscriptions)

## Output Expectations

When using this skill, produce:

- The files changed
- Whether `proxy-utils.esm.mjs` was downloaded successfully
- Whether conversion runs before plugin trigger
- Whether default User-Agent was added
- Whether diagnostics passed
- Whether the hard error was replaced with warning
- Traffic info parsing status (if applicable)

## Example Use

Invoke this skill when the user says things like:

- "新版本同步后，把内置节点转换改回去"
- "重新给这个项目打上内置 proxy-utils 转换的补丁"
- "升级 upstream 后，订阅导入失败提示需要安装插件"
- "将节点转换功能内置到应用中"
- "让应用支持直接导入 Clash 格式订阅"
- "订阅无法显示流量信息"
- "无法获取 upload download total 流量统计"