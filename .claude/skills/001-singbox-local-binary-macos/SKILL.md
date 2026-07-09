---
name: "singbox-local-binary-macos"
description: "Makes GUI.for.SingBox prefer a locally installed macOS sing-box binary instead of downloading one. Invoke when updating upstream and reapplying the Homebrew sing-box integration."
---

# Sing-box Local Binary On macOS

Use this skill when updating `GUI.for.SingBox` to a new upstream version and you need to reapply the customization that prefers the locally installed macOS `sing-box` binary, especially Homebrew installs such as `/usr/local/bin/sing-box`.

## Goal

Make the app prefer an existing macOS system binary for the stable branch:

- First try `/usr/local/bin/sing-box`
- Then try `/opt/homebrew/bin/sing-box`
- Fall back to the bundled binary under `data/sing-box/...` when no local binary is available

Keep alpha builds on the bundled binary path unless the project explicitly changes that policy.

## Files Usually Involved

- `frontend/src/utils/helper.ts`
- `frontend/src/stores/kernelApi.ts`
- `frontend/src/hooks/useCoreBranch.ts`

## Required Behavior

1. Add a reusable executable path resolver in `frontend/src/utils/helper.ts`.
2. Make core startup use the resolved executable path instead of hardcoding `data/sing-box/...`.
3. Make version detection, privilege grant, and "open file location" use the same resolved path.
4. Prevent the settings UI from treating a system-installed binary as a downloadable bundled core.
5. Preserve fallback behavior so bundled downloads still work when no local binary exists.

## Implementation Steps

### 1. Add path helpers

In `frontend/src/utils/helper.ts`, keep `getKernelFileName()` as-is and add helpers similar to:

```ts
export const getKernelBundlePath = (isAlpha = false) => {
  return `${CoreWorkingDirectory}/${getKernelFileName(isAlpha)}`
}

export const getKernelExecutablePath = async (isAlpha = false) => {
  const { os } = useEnvStore().env
  if (!isAlpha && os === OS.Darwin) {
    for (const path of ['/usr/local/bin/sing-box', '/opt/homebrew/bin/sing-box']) {
      if (await FileExists(path).catch(() => false)) {
        return path
      }
    }
  }
  return getKernelBundlePath(isAlpha)
}

export const getKernelExecutableDirectory = async (isAlpha = false) => {
  const path = await getKernelExecutablePath(isAlpha)
  const lastSlashIndex = path.lastIndexOf('/')
  return lastSlashIndex > 0 ? path.slice(0, lastSlashIndex) : path
}
```

Notes:

- Import `FileExists` and reuse existing `OS`, `CoreWorkingDirectory`, and `useEnvStore`.
- Only prefer the local binary for stable macOS by default.

### 2. Update core launch path

In `frontend/src/stores/kernelApi.ts`:

- Replace hardcoded startup path usage based on `CoreWorkingDirectory + '/' + getKernelFileName(isAlpha)`.
- Resolve the path with `await getKernelExecutablePath(isAlpha)` before `ExecBackground(...)`.
- Keep runtime args, env vars, pid file, log file, and stop keyword behavior unchanged.

Expected pattern:

```ts
const runCoreProcess = async (isAlpha: boolean) => {
  const corePath = await getKernelExecutablePath(isAlpha)
  return new Promise<number | void>((resolve, reject) => {
    const pid = ExecBackground(corePath, getKernelRuntimeArgs(isAlpha), ...)
  })
}
```

### 3. Update settings-side version and action logic

In `frontend/src/hooks/useCoreBranch.ts`:

- Replace direct bundled path assumptions with `getKernelBundlePath()`, `getKernelExecutablePath()`, and `getKernelExecutableDirectory()`.
- When reading local version, call `Exec(executablePath, ['version'])`.
- When granting TUN permission, pass the resolved executable path.
- When opening file location, open the resolved executable directory.

Track the currently resolved path in a ref, for example:

```ts
const executablePath = ref('')
```

Refresh it inside local version detection so the UI knows which binary is active.

### 4. Guard update and rollback UI for local binaries

If the active executable is a system binary instead of the bundled binary:

- Do not show it as updateable against the bundled download flow
- Do not allow restart-after-download behavior that assumes the downloaded file replaced the running bundled binary
- Disable rollback state derived from bundled `.bak` files

Typical checks:

```ts
executablePath.value === CoreFilePath
```

Use that condition in:

- `updatable`
- `restartable`
- bundled rollback detection

### 5. Keep bundled download flow intact

Do not remove the existing download logic in `useCoreBranch.ts`.

The bundled downloader should still:

- Create `data/sing-box`
- Download the release asset
- Unpack it to cache
- Move the bundled binary into place
- `chmod +x` non-Windows binaries

This preserves fallback behavior when the local system binary is absent.

## Validation Checklist

After applying the patch:

1. Run diagnostics on:
   - `frontend/src/utils/helper.ts`
   - `frontend/src/stores/kernelApi.ts`
   - `frontend/src/hooks/useCoreBranch.ts`
2. Confirm no new lint or type errors appear.
3. Manually verify behavior on macOS:
   - If `/usr/local/bin/sing-box` exists, stable branch should use it.
   - If only `/opt/homebrew/bin/sing-box` exists, stable branch should use it.
   - If neither exists, the app should still use the bundled binary.
4. Confirm alpha branch still uses bundled binaries unless intentionally changed.

## Search Hints

If upstream moved code around, search for:

- `getKernelFileName`
- `CoreWorkingDirectory`
- `ExecBackground(`
- `GrantTUNPermission(`
- `OpenDir(`
- `version`
- `downloadCore`

## Output Expectations

When using this skill, produce:

- The files changed
- The exact fallback order used for macOS
- Whether alpha behavior was preserved
- Whether diagnostics passed

## Example Use

Invoke this skill when the user says things like:

- "新版本同步后，把 macOS 上优先用 brew 的 sing-box 改回去"
- "重新给这个项目打上本地 `/usr/local/bin/sing-box` 的补丁"
- "升级 upstream 后，再应用本地 sing-box 优先逻辑"
