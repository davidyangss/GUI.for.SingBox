# Bug Report: Local Subscription Nodes Not Merged into Generated Config

## Summary

When a local subscription JSON file (e.g., `data/subscribes/ID_claw_tyo_self.json`) is manually placed into the `subscribes/` directory and referenced by a profile's outbounds, GUI.for.SingBox generates the runtime `sing-box/config.json` with **empty shell outbounds** — nodes contain only `type` and `tag` but no connection parameters (`server`, `tls`, `uuid`, etc.), causing a fatal startup error.

## Error

```
FATAL[0000] create service: initialize outbound[7]: TLS required
```

## Environment

- **GUI.for.SingBox version**: macOS App (latest)
- **sing-box version**: 1.13.12
- **Platform**: macOS (Apple Silicon)

## Steps to Reproduce

1. Manually create a local subscription file at `data/subscribes/ID_claw_tyo_self.json`:

```json
[
  {
    "tag": "🇯🇵 自建 VLESS-Reality",
    "type": "vless",
    "server": "[240b:4009:25a:1802:ffff:e154:e0fb:8951]",
    "server_port": 443,
    "uuid": "28002221-b316-462c-aaa4-37af6bb14338",
    "flow": "xtls-rprx-vision",
    "tls": {
      "enabled": true,
      "server_name": "www.bing.com",
      "reality": {
        "enabled": true,
        "public_key": "a4iZf6omnytF25sWOXbZXAsmjz73OUKhCoJ1sEuA-Bk",
        "short_id": "d12a333de5117d1d"
      },
      "utls": {
        "enabled": true,
        "fingerprint": "chrome"
      }
    }
  },
  {
    "tag": "🇯🇵 自建 HY2",
    "type": "hysteria2",
    "server": "[240b:4009:25a:1802:ffff:e154:e0fb:8951]",
    "server_port": 443,
    "password": "YMCbAoCrZv1mHd9y/lHMQg==",
    "tls": {
      "enabled": true,
      "server_name": "www.bing.com",
      "insecure": true
    }
  }
]
```

2. In a profile (`profiles.yaml`), create outbound selectors that reference these nodes by tag (`🇯🇵 自建 VLESS-Reality`, `🇯🇵 自建 HY2`).

3. Start the service via GUI.

## Expected Behavior

The generated `data/sing-box/config.json` should merge the full node configuration from the subscription file into the outbound definitions:

```json
{
  "type": "vless",
  "tag": "🇯🇵 自建 VLESS-Reality",
  "server": "[240b:4009:25a:1802:ffff:e154:e0fb:8951]",
  "server_port": 443,
  "uuid": "28002221-b316-462c-aaa4-37af6bb14338",
  "flow": "xtls-rprx-vision",
  "tls": {
    "enabled": true,
    "server_name": "www.bing.com",
    "reality": {
      "enabled": true,
      "public_key": "a4iZf6omnytF25sWOXbZXAsmjz73OUKhCoJ1sEuA-Bk",
      "short_id": "d12a333de5117d1d"
    },
    "utls": {
      "enabled": true,
      "fingerprint": "chrome"
    }
  }
}
```

## Actual Behavior

The generated `data/sing-box/config.json` contains only **empty shell outbounds** with no connection parameters:

```json
{
  "type": "vless",
  "tag": "🇯🇵 自建 VLESS-Reality"
},
{
  "type": "hysteria2",
  "tag": "🇯🇵 自建 HY2"
}
```

This causes sing-box to fail with `TLS required` because the Hysteria2 outbound has no `tls` block.

## Root Cause Analysis

The issue is that the **local subscription file `ID_claw_tyo_self.json` has no corresponding entry in `data/subscribes.yaml`**.

### How GUI config generation works:

1. GUI reads the active profile from `data/profiles.yaml`
2. For each outbound that references a subscription node, GUI looks up `data/subscribes.yaml` to find the subscription entry
3. GUI reads the subscription's JSON file (e.g., `data/subscribes/ID_px3gj50f.json`) and merges the full node config (server, tls, uuid, etc.) into the outbound
4. The merged config is written to `data/sing-box/config.json`

### What goes wrong:

- HTTP subscriptions (like `xsus`, `宝妈云`) have entries in `subscribes.yaml` with `type: Http`, `url`, `proxies` list, etc.
- The local subscription `ID_claw_tyo_self.json` was **manually created** — it has **no entry** in `subscribes.yaml`
- When GUI tries to merge node data for `🇯🇵 自建 VLESS-Reality` and `🇯🇵 自建 HY2`, it cannot find their subscription in `subscribes.yaml`
- GUI falls back to generating empty outbounds with only `type` and `tag`

### Comparison with working HTTP subscriptions:

**Working** — HTTP subscription in `subscribes.yaml`:
```yaml
- id: ID_px3gj50f
  name: xsus
  type: Http
  url: https://xsus.jolqx.cn/api/v1/client/subscribe?token=...
  path: data/subscribes/ID_px3gj50f.json
  proxies:
    - id: ID_yw8q29f2
      tag: 🇬🇧 剩余流量：37.93 GB
      type: vless
    # ... many proxies
```

**Missing** — Local subscription has NO entry in `subscribes.yaml`:
```yaml
# ID_claw_tyo_self is NOT registered here!
# But data/subscribes/ID_claw_tyo_self.json exists on disk
```

## UI Change Triggers Config Regeneration (Recurring Failure)

This is **not a one-time issue** — it recurs every time the GUI regenerates `config.json`. Any of the following actions triggers a full config regeneration, overwriting any manual fix:

- Switching profiles in the GUI
- Modifying any profile setting (DNS, route rules, inbounds, etc.)
- Clicking "Apply" or "Start" in the GUI
- Updating/refreshing other HTTP subscriptions
- Restarting the GUI application

**Reproduction**:

1. Manually fix `data/sing-box/config.json` with complete node parameters
2. Verify fix works: `cd data/sing-box && sing-box run -c config.json` → starts successfully
3. Open GUI.for.SingBox, make any UI change (e.g., toggle a setting, switch profile tab)
4. GUI regenerates `data/sing-box/config.json`
5. The regenerated config **reverts to empty shell outbounds** again
6. Service fails with the same `TLS required` error

This means **users cannot use the GUI at all** for profiles that reference local subscription nodes. The only workaround is to avoid using the GUI entirely and run sing-box manually from the command line — defeating the purpose of having a GUI.

## Workaround

Manually edit `data/sing-box/config.json` to fill in the complete node parameters:

```bash
cd /Applications/GUI.for.SingBox.app/Contents/MacOS/data/sing-box
# Edit config.json to fill in VLESS and HY2 outbound parameters
sing-box check -c config.json  # Verify syntax
sing-box run -c config.json    # Start
```

**This fix is temporary** — it will be overwritten on the next GUI config regeneration (see section above). The only permanent solution is a GUI source code fix.

## Suggested Fix

One of the following approaches:

### Option A: Support local subscriptions in `subscribes.yaml`

Allow a `type: Local` subscription entry in `subscribes.yaml`:

```yaml
- id: ID_claw_tyo_self
  name: claw.tyo (自建)
  type: Local
  path: data/subscribes/ID_claw_tyo_self.json
  proxies:
    - id: ID_claw_vless
      tag: 🇯🇵 自建 VLESS-Reality
      type: vless
    - id: ID_claw_hy2
      tag: 🇯🇵 自建 HY2
      type: hysteria2
```

### Option B: Add a UI flow for manual/local subscriptions

Provide a way in the GUI to create a local subscription (import JSON file or manually add nodes), which automatically creates the `subscribes.yaml` entry and the JSON file.

### Option C: Graceful fallback

When a referenced subscription node cannot be found in `subscribes.yaml`, attempt to read the corresponding JSON file directly from `data/subscribes/` by matching the tag name, rather than generating an empty shell outbound.

## Additional Notes

- The `client-config.json` used as the source of truth for the node parameters is at:
  `/idata/.trae/skills/vps-singbox-setup/client-config.json`
- This config was verified to work correctly when launched directly with `sing-box run -c client-config.json`
- The issue only manifests when using the GUI's config generation pipeline
