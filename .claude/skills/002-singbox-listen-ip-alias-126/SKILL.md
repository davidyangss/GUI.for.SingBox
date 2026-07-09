---
name: "singbox-listen-ip-alias-126"
description: "Replaces GUI.for.SingBox localhost defaults with 126.0.0.1 for listen IP and 7897 for mixed inbound port, controller, and proxy access. Invoke when syncing a new upstream version and reapplying the 126.0.0.1 alias patch."
---

# GUI.for.SingBox Configurable Listen IP and Port Patch (formerly 126.0.0.1 Alias Patch)

Use this skill when updating `GUI.for.SingBox` to a new upstream version and you need to reapply the local customization that makes the listen IP (previously hardcoded to `126.0.0.1`) and mixed inbound port (defaulting to `7897`) configurable in the UI.

This patch is intended for a personal environment where:

- the host has an IP alias such as `126.0.0.1`
- OrbStack containers need to access the host proxy/controller through that alias
- the default localhost-only behavior should move from `127.0.0.1` to a configurable IP (defaulting to `126.0.0.1`)
- the default mixed inbound port should be `7897` instead of the upstream default

## Goal

Make the frontend use a configurable `mixInboundIP` (stored in `AppSettings`) instead of hardcoded `127.0.0.1` or `126.0.0.1`, **and** a configurable `mixInboundPort` (defaulting to `7897`) instead of any upstream default, for:

- default inbound `listen` addresses
- default inbound `listen_port` (mixed proxy port)
- default `clash_api.external_controller`
- Home overview temporary "not allow LAN" listen address
- controller API base URL construction
- system proxy detection and system proxy setup
- helper-generated proxy URLs
- visible UI placeholders that mention the local loopback/default address or port

Also provide UI settings in the "Advanced" section to change both the IP and the port.

## Files Usually Involved

- `frontend/src/types/app.d.ts` (added `mixInboundIP` and `mixInboundPort` to `AppSettings`)
- `frontend/src/stores/appSettings.ts` (initialized `mixInboundIP` and `mixInboundPort` defaults)
- `frontend/src/lang/locale/zh.ts` / `en.ts` (added translations)
- `frontend/src/views/SettingsView/components/components/AdvancedSettings.vue` (added UI settings)
- `frontend/src/views/HomeView/components/CommonController.vue` (added UI settings in Core Settings modal)
- `frontend/src/constant/profile.ts`
- `frontend/src/stores/kernelApi.ts`
- `frontend/src/api/kernel.ts`
- `frontend/src/stores/env.ts`
- `frontend/src/utils/helper.ts`
- `frontend/src/views/ProfilesView/components/DnsServersConfig.vue`
- `frontend/src/views/ProfilesView/components/InboundsConfig.vue`

## Required Behavior

1. Use `appSettings.app.mixInboundIP` instead of `127.0.0.1` or `126.0.0.1` for all local bind/controller/proxy endpoints.
2. Use `appSettings.app.mixInboundPort` (defaulting to `7897`) for the mixed inbound port.
3. Keep `allow-lan = true` behavior unchanged as `0.0.0.0`.
4. When `allow-lan = false`, use `appSettings.app.mixInboundIP` and `appSettings.app.mixInboundPort`.
5. Make controller API access honor the host from `experimental.clash_api.external_controller` or fallback to `appSettings.app.mixInboundIP`.
6. Provide input fields in "Advanced Settings" to manage both IP and port.

## Implementation Steps

### 1. Update App Settings and UI

- Add `mixInboundIP: string` and `mixInboundPort: number` to `AppSettings` in `frontend/src/types/app.d.ts`.
- Initialize `mixInboundIP: '126.0.0.1'` and `mixInboundPort: 7897` in `frontend/src/stores/appSettings.ts`.
- Add translation keys `mixInboundIP` and `mixInboundPort` in `frontend/src/lang/locale/zh.ts` and `en.ts`.
- Add an `Input` for `appSettings.app.mixInboundIP` in `frontend/src/views/SettingsView/components/components/AdvancedSettings.vue`.
- Add a numeric `Input` for `appSettings.app.mixInboundPort` in `AdvancedSettings.vue`.
- Add an `Input` for `kernelApiStore.config['mix-inbound-ip']` in `frontend/src/views/HomeView/components/CommonController.vue` (Core Settings modal).
- Add a numeric `Input` for `kernelApiStore.config['mix-inbound-port']` in the Core Settings modal.

### 2. Update profile defaults

In `frontend/src/constant/profile.ts`:

- change `DefaultInboundMixed` to accept optional `listen` (defaulting to `126.0.0.1`) and `listen_port` (defaulting to `7897`) parameters.
- update `DefaultExperimental().clash_api.external_controller` to use `126.0.0.1:20123` (or better, make it dynamic if possible, though constants are hard).

In `frontend/src/views/ProfilesView/components/InboundsConfig.vue`:

- pass `appSettings.app.mixInboundIP` and `appSettings.app.mixInboundPort` to `DefaultInboundMixed()` when adding a new inbound.

### 2.5. Defensive fallback for `mixInboundIP` and `mixInboundPort` when loading old settings

When users upgrade from a version that didn't have `mixInboundIP` or `mixInboundPort`, the saved YAML config file will be missing these fields. Without a fallback, `appSettings.app.mixInboundIP` becomes `undefined`, causing proxy URLs to be generated as `http://:7897` (missing IP), and `mixInboundPort` becomes `undefined`, causing inbound creation to produce an inbound with no port.

In `frontend/src/stores/appSettings.ts`, inside `setupAppSettings()`, add after the existing `kernel.main` fallback:

```ts
if (!settings.mixInboundIP) {
  settings.mixInboundIP = '126.0.0.1'
}
if (!settings.mixInboundPort) {
  settings.mixInboundPort = 7897
}
```

In `frontend/src/utils/helper.ts`, in `GetSystemOrKernelProxy()`, add fallbacks on both fields:

```ts
const ip = useAppSettingsStore().app.mixInboundIP || '126.0.0.1'
const port = useAppSettingsStore().app.mixInboundPort || 7897
```

This ensures the proxy address is always well-formed even if the fields are `undefined` or empty.

### 3. Update runtime behavior

In `frontend/src/stores/kernelApi.ts`:

- Add `'mix-inbound-ip': string` and `'mix-inbound-port': number` to `CoreApiConfig` interface in `frontend/src/types/kernel.d.ts`.
- Initialize `'mix-inbound-ip': ''` and `'mix-inbound-port': 0` in `kernelApiStore` config state.
- In `refreshConfig`, sync `config.value['mix-inbound-ip']` with `appSettingsStore.app.mixInboundIP` and `config.value['mix-inbound-port']` with `appSettingsStore.app.mixInboundPort`.
- Implement `patchInboundListen(ip: string)` to update `appSettingsStore.app.mixInboundIP` and update all non-LAN inbounds in `runtimeProfile`.
- Implement `patchInboundPort(port: number)` (or extend the existing one) to update `appSettingsStore.app.mixInboundPort` and update all mixed inbounds in `runtimeProfile`.
- Add `'mix-inbound-ip'` and `'mix-inbound-port'` handlers to `fieldHandlerMap` in `updateConfig`.
- Replace hardcoded `126.0.0.1` with `appSettingsStore.app.mixInboundIP` in `patchInboundAddress`.
- Use `appSettingsStore.app.mixInboundIP` and `appSettingsStore.app.mixInboundPort` in `patchInboundPort` when creating a new inbound.

In `frontend/src/stores/env.ts`:

- replace `126.0.0.1` with `appSettings.app.mixInboundIP` in `updateSystemProxyStatus` (for `proxyServerList`).
- replace the hardcoded proxy port with `appSettings.app.mixInboundPort` in `updateSystemProxyStatus` and `setSystemProxy` when calling `SetSystemProxy`.
- replace `126.0.0.1` with `appSettings.app.mixInboundIP` in `setSystemProxy` when calling `SetSystemProxy`.

In `frontend/src/utils/helper.ts`:

- replace hardcoded `126.0.0.1` in `GetSystemOrKernelProxy` with `useAppSettingsStore().app.mixInboundIP`.
- replace any hardcoded proxy port in `GetSystemOrKernelProxy` with `useAppSettingsStore().app.mixInboundPort || 7897`.

### 4. Update controller API host handling

In `frontend/src/api/kernel.ts`:

- import `useAppSettingsStore`.
- in `setupCoreApi`, use `appSettings.mixInboundIP` to construct the default controller address and fallback host.

### 5. Update UI placeholders

In `frontend/src/views/ProfilesView/components/DnsServersConfig.vue`:

- replace hardcoded `126.0.0.1` in `KeyValueEditor` placeholder with `appSettings.app.mixInboundIP`.

## Validation Checklist

1. Verify that "Advanced Settings" shows both the "Mixed Inbound Listen IP" and "Mixed Inbound Port" fields.
2. Verify that the "Core Settings" modal (Home Overview) shows both fields and they update the runtime config correctly.
3. Change the IP in settings and verify:
   - new "Mixed" inbounds use the new IP.
   - system proxy setup uses the new IP.
   - controller API continues to work (if the core is listening on that IP).
   - "not allow LAN" mode in Home overview uses the new IP.
4. Change the port in settings and verify:
   - new "Mixed" inbounds use the new port.
   - system proxy URL uses the new port (`http://126.0.0.1:<port>`).
   - helper-generated proxy URLs reflect the new port.
5. Confirm that `126.0.0.1` is no longer hardcoded in the codebase (except as a default value in settings).
6. Confirm that the upstream mixed port default is no longer hardcoded anywhere outside the settings defaults.
7. Delete the `data/user.yaml` saved settings file (or ensure it has no `mixInboundIP`/`mixInboundPort` fields) and restart — verify that proxy-based requests (e.g. sing-box version check) still work (i.e., proxy URL is `http://126.0.0.1:7897` not `http://:7897` or `http://126.0.0.1:`).

## Search Hints
... (existing hints) ...

## Notes

- This is a personal-environment patch, not a general upstream-safe default.
- `126.0.0.1` is not part of the standard loopback range; it depends on the host alias existing.
- If current saved profiles still contain old `127.0.0.1` values or old port numbers, they may need to be migrated or manually edited outside this skill.

## Output Expectations

When using this skill, report:

- which files were changed
- whether runtime `listen` and `listen_port` preservation logic was kept
- whether any `127.0.0.1` matches remain in `frontend/src`
- whether the upstream hardcoded port was replaced everywhere
- whether diagnostics passed for edited files

## Example Use

Invoke this skill when the user says things like:

- "升级 upstream 后，把 listen ip 和 localhost 默认值再改回 126.0.0.1"
- "新版本同步后，重新应用 126.0.0.1 alias 补丁"
- "把 GUI for singbox 的前端默认监听地址继续维持为 126.0.0.1"
- "把混合端口默认值改成 7897"
- "新版本同步后，重新应用 126.0.0.1 + 7897 端口补丁"
