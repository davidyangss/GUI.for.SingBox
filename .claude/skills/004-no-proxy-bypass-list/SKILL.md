---
name: "no-proxy-bypass-list"
description: "为系统代理绕过列表设置合理的默认值。当新用户发现本地/内网地址走了代理、proxyBypassList 为空、需要补充 127.0.0.1/localhost/192.168.0.0/16 等常见地址时调用此 skill。"
---

# Default Proxy Bypass List

Use this skill when working in `GUI.for.SingBox` and the user reports:

- 本地地址（127.0.0.1, localhost）走了代理
- 内网地址（192.168.x.x, 10.x.x.x）无法直连
- "不使用代理的地址" 配置为空
- 新用户重置配置后缺少合理的 bypass 规则

## Root Cause

**File**: `frontend/src/stores/appSettings.ts`

Default value for `proxyBypassList` is `''` (empty string). If OS has no system proxy bypass config, the field remains empty, causing local/private addresses to route through proxy.

## Fix

**Location**: Default settings object, `proxyBypassList` field (~line 71)

The app uses **semicolon** (`;`) as separator (UI tip: `proxyBypassListTips: '分号分隔'`).

```typescript
// Before
proxyBypassList: '',

// After
proxyBypassList: '127.0.0.1;localhost;126.0.0.1;10.0.0.0/8;192.168.0.0/16;.orb.local;.local;.orb.internal;.internal',
```

### Address Meanings

| Address | Purpose |
|---------|---------|
| `127.0.0.1` | IPv4 loopback |
| `localhost` | Loopback hostname |
| `126.0.0.1` | Alternate loopback |
| `10.0.0.0/8` | Class A private network |
| `192.168.0.0/16` | Class C private network |
| `.orb.local` | OrbStack local domain |
| `.local` | mDNS local domain |
| `.orb.internal` | OrbStack internal |
| `.internal` | Internal services |

### Side Effect

After setting a non-empty default, the following logic in `setupAppSettings` will NOT run for new users:

```typescript
if (!settings.proxyBypassList) {
  settings.proxyBypassList = (await ignoredError(GetSystemProxyBypass)) || ''
}
```

New users get the hardcoded default instead of inheriting OS system proxy bypass list.

## Version Update Checklist

After upstream merges, verify in `frontend/src/stores/appSettings.ts`:

- [ ] `proxyBypassList` field exists
- [ ] Default value includes all target addresses (semicolon-separated)
- [ ] UI tip still shows "分号分隔" (`frontend/src/lang/locale/zh.ts` → `proxyBypassListTips`)

Search pattern:

```typescript
proxyBypassList:
```

Ensure value matches:

```
127.0.0.1;localhost;126.0.0.1;10.0.0.0/8;192.168.0.0/16;.orb.local;.local;.orb.internal;.internal
```

## Testing

1. Delete or clear `data/user.yaml`
2. Restart app
3. Open 「软件设置 → 不使用代理的地址」
4. **Expected**: Default shows semicolon-separated address list, not blank

## Impact

- **File**: `frontend/src/stores/appSettings.ts`
- **Function**: System proxy settings → proxy bypass list (default value)
- **Risk**: Low — only changes default; existing user configs unaffected
- **Compatibility**: Fully backward compatible (saved `data/user.yaml` takes precedence)
