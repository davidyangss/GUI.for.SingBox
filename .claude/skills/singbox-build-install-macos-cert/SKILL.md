---
name: "singbox-build-install-macos-cert"
description: "Builds, signs, and installs GUI.for.SingBox on macOS and explains how to use custom certificates. Invoke when compiling locally, packaging the app, code-signing with yssbook-codesign, or configuring self-owned certs."
---

# Build, Sign And Install GUI.for.SingBox On macOS

Use this skill when working in `GUI.for.SingBox` and the user wants to:

- build the app locally on macOS
- verify the local toolchain before building
- package the Wails app into a `.app`
- sign the `.app` with the `yssbook-codesign` certificate
- install the built app to `/Applications`
- 更新到MacOS中
- configure the generated sing-box config to use user-provided certificates

## Goal

Produce a working, signed local macOS build of `GUI.for.SingBox`, install it to `/Applications`, and document the supported path for custom certificates.

This skill is primarily operational. It usually does not require source edits unless the user explicitly asks for UI or behavior changes.

---

## Pipeline Overview

The full process runs in this order:

```
Step 1: Build frontend       →  pnpm install && pnpm build
Step 2: Package with Wails    →  wails build
Step 3: Sign with certificate →  codesign --force --deep --sign "yssbook Local Code Signing"
Step 4: Verify signature      →  codesign -dvvv
Step 5: Install to /Applications → cp -R
```

---

## URL Scheme Registration (singbox://)

The app supports `singbox://` custom URL scheme for importing subscription configs from browser links.

**For detailed diagnosis, fix implementation, and troubleshooting, see the dedicated skill: `singbox-url-scheme-macos`.**

Quick verification after build:

```bash
/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" /Applications/GUI.for.SingBox.app/Contents/Info.plist
```

Expected output should include `singbox` under `CFBundleURLSchemes`.

---

## Prerequisites

### Toolchain

Check these tools first:

```bash
node -v && pnpm -v && go version && wails version
```

### Code-Signing Certificate

The signing certificate is stored at:

```
/idata/etc/ssl.certificate/yssbook-codesign/
```

Files in this directory:

| File | Purpose |
|------|---------|
| `codesign.p12` | PKCS#12 bundle (cert + private key) for importing into Keychain |
| `codesign.crt` | X.509 certificate (PEM) |
| `codesign.key` | Private key (PEM) |
| `openssl-codesign.cnf` | OpenSSL config used to generate the certificate |

Certificate identity name in Keychain:

```
yssbook Local Code Signing
```

To verify the certificate is available in the keychain:

```bash
security find-identity -v -p codesigning
```

Expected output should include `"yssbook Local Code Signing"`. If not present, import the `.p12` file first (see troubleshooting section).

### Expected Project Layout

- repo root contains `wails.json`
- frontend lives in `frontend/`
- build output is under `build/bin/`

---

## Step 1: Build Frontend

Run from the `frontend/` directory:

```bash
cd /private/idata/icoding/projects/singbox/GUI.for.SingBox.git/frontend
pnpm install --frozen-lockfile
pnpm build
```

Expected: Vite build completes without errors, output in `frontend/dist/`.

---

## Step 2: Package With Wails

Run from repo root:

```bash
cd /private/idata/icoding/projects/singbox/GUI.for.SingBox.git
wails build
```

Expected output:

```text
build/bin/GUI.for.SingBox.app
```

At this point the app has only an **ad-hoc** signature (flag `0x2(adhoc)`). The next step replaces it with the `yssbook` certificate.

---

## Step 3: Sign With yssbook-codesign Certificate

Use `codesign` to replace the ad-hoc signature with the `yssbook Local Code Signing` identity:

```bash
codesign --force --deep --sign "yssbook Local Code Signing" \
  --timestamp=none \
  /private/idata/icoding/projects/singbox/GUI.for.SingBox.git/build/bin/GUI.for.SingBox.app
```

Flags explained:

| Flag | Meaning |
|------|---------|
| `--force` | Replace any existing signature |
| `--deep` | Sign all nested bundles/frameworks |
| `--sign "yssbook Local Code Signing"` | The Keychain identity to sign with |
| `--timestamp=none` | Do not request a timestamp from Apple (self-signed cert) |

---

## Step 4: Verify Signature

Confirm the app is signed with the correct certificate:

```bash
codesign -dvvv /private/idata/icoding/projects/singbox/GUI.for.SingBox.git/build/bin/GUI.for.SingBox.app
```

Expected key lines in output:

```
Authority=yssbook Local Code Signing
Signature size=XXXX      ← not "adhoc"
```

If you see `Signature=adhoc` or `flags=0x2(adhoc)`, the signing did not take effect — re-run Step 3.

---

## Step 5: Install To /Applications

Using `cp -R` to overwrite the existing `.app` in `/Applications/` preserves user configuration. The app's config files are stored in user directories (e.g., `~/Library/Application Support/GUI.for.SingBox/`), not inside the `.app` bundle, so replacing the app package does not affect user data.

Try the direct copy first:

```bash
cp -R "/private/idata/icoding/projects/singbox/GUI.for.SingBox.git/build/bin/GUI.for.SingBox.app" /Applications/
```

If the environment is sandboxed or permission-restricted, this will fail with `operation not permitted`. In that case:

1. Keep the built artifact in `build/bin/GUI.for.SingBox.app`
2. Tell the user the app was built and signed successfully
3. Instruct the user to run the copy command **in their own terminal** (outside the sandbox):

```bash
cp -R "/private/idata/icoding/projects/singbox/GUI.for.SingBox.git/build/bin/GUI.for.SingBox.app" /Applications/
```

If that also fails with a permission error, suggest:

```bash
sudo cp -R "/private/idata/icoding/projects/singbox/GUI.for.SingBox.git/build/bin/GUI.for.SingBox.app" /Applications/
```

Only suggest `sudo` when the non-privileged copy fails and the user is performing the step in their own terminal.

### First Launch (Gatekeeper)

Since `yssbook Local Code Signing` is a self-signed certificate (not issued by Apple), macOS Gatekeeper may block the app on first launch. The user must:

1. Right-click (or Control-click) the app in Finder
2. Select **Open**
3. Click **Open** in the confirmation dialog

This only needs to be done once.

---

## Troubleshooting

### Certificate not found in Keychain

If `security find-identity -v -p codesigning` does not show `yssbook Local Code Signing`, import the `.p12` file:

```bash
security import /idata/etc/ssl.certificate/yssbook-codesign/codesign.p12 \
  -k ~/Library/Keychains/login.keychain-db \
  -T /usr/bin/codesign
```

If the `.p12` has a password, add `-P <password>` to the command.

### Signature verification shows "adhoc"

This means `codesign` fell back to ad-hoc signing. Check:

- The identity name is exactly `"yssbook Local Code Signing"` (with quotes)
- The certificate is in the login keychain (not system keychain)
- `codesign` can access the private key (no password prompt was skipped)

---

## Custom Certificate Support (sing-box Config)

The current GUI model does not expose dedicated certificate fields for every sing-box TLS structure, but the project already supports config post-processing through profile mixins and scripts.

The key implementation path is:

- profile editor exposes `Mixin & Script`
- config generation merges `profile.mixin.config`
- then runs `profile.script.code`

Important files:

- `frontend/src/views/ProfilesView/components/MixinAndScriptConfig.vue`
- `frontend/src/utils/generator.ts`

In `generator.ts`, config generation applies:

1. GUI-generated base config
2. plugin processing
3. mixin merge
4. script `onGenerate(config)`

That means user-provided certificate configuration should usually be injected with a mixin instead of adding new GUI fields.

## How To Use Own Certificates

Open the target profile in the app and go to:

- `Profiles`
- `Mixin & Script`

Set `Mixin` format to `json` or `yaml`, then inject the needed TLS fields for the relevant sing-box object.

Typical examples include:

- `tls.certificate_path`
- `tls.key_path`
- `tls.server_name`
- `tls.insecure`

Example JSON mixin:

```json
{
  "outbounds": [
    {
      "tag": "my-node",
      "tls": {
        "enabled": true,
        "server_name": "example.com",
        "certificate_path": "/absolute/path/to/client-or-server.crt",
        "key_path": "/absolute/path/to/client-or-server.key"
      }
    }
  ]
}
```

Example YAML mixin:

```yaml
outbounds:
  - tag: my-node
    tls:
      enabled: true
      server_name: example.com
      certificate_path: /absolute/path/to/client-or-server.crt
      key_path: /absolute/path/to/client-or-server.key
```

Use absolute paths.

If the certificate must be applied to another object, such as an inbound or transport block, adapt the mixin to that exact sing-box schema location rather than forcing it into the GUI model.

## Validation Checklist

After running this skill, verify each step:

| Step | Check |
|------|-------|
| 1. Toolchain | `node`, `pnpm`, `go`, `wails` versions detected and reported |
| 2. Certificate | `yssbook Local Code Signing` found in keychain via `security find-identity` |
| 3. Frontend build | `pnpm build` passed, `frontend/dist/` populated |
| 4. Wails package | `wails build` passed, `build/bin/GUI.for.SingBox.app` exists |
| 5. Codesign | `codesign --sign "yssbook Local Code Signing"` succeeded |
| 6. Signature verify | `codesign -dvvv` shows `Authority=yssbook Local Code Signing`, not adhoc |
| 7. Install | `build/bin/GUI.for.SingBox.app` copied to `/Applications/` or user instructed to do so |
| 8. URL Scheme | `Info.plist` contains `CFBundleURLTypes` with `singbox` scheme (see `singbox-url-scheme-macos` for details) |
| 9. Sing-box certs | User informed that custom TLS certificates are configured through `Mixin & Script` |

## Search Hints

If files move in a newer upstream version, search for:

- `MixinAndScriptConfig`
- `generateConfig`
- `enableMixinProcessing`
- `enableScriptProcessing`
- `onGenerate(config)`
- `wails.json`
- `CFBundleURLTypes`
- `OnUrlOpen`
- `protocols`
- `singbox://`

## Output Expectations

When using this skill, report:

- detected tool versions (node, pnpm, go, wails)
- whether the `yssbook Local Code Signing` certificate was found in keychain
- whether frontend build succeeded
- whether Wails packaging succeeded
- where the `.app` was generated
- codesigning result: Authority name, signature size, signed time
- whether install succeeded or was blocked by sandbox
- if blocked: the exact `cp` command the user should run in their own terminal
- URL scheme verification: whether `CFBundleURLTypes` with `singbox` is present in `Info.plist`
- how the user should inject TLS certificate paths (via `Mixin & Script`)

## Example Use

Invoke this skill when the user says things like:

- "在我机器上编译并安装 GUI.for.SingBox"
- "帮我本地打包这个 macOS app，用 yssbook 证书签名"
- "我想用自己的证书，顺便把构建流程跑一遍"
- "检查这个仓库怎么在 mac 上编译并配置证书"
- "构建并用 codesign 签名后安装"

Note: For URL scheme issues (`singbox://` not working), invoke `singbox-url-scheme-macos` instead.
