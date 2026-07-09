---
name: "singbox-plugin-hub-mirror-sync"
description: "Fixes empty plugin hub by replacing GitHub URLs with Fastly JSDelivr mirrors and handles automatic migration. Invoke when syncing upstream or when plugin list is empty."
---

# SingBox Plugin Hub Mirror Sync

This skill ensures that the **Plugin Hub** remains accessible in regions where `raw.githubusercontent.com` is blocked by redirecting requests to the **Fastly JSDelivr** mirror.

## Goal
Maintain a working plugin list by using stable mirrors and ensuring user configurations are automatically migrated to the new URLs.

## Implementation Details

### 1. Default Source Configuration
The default plugin sources must be updated to use the Fastly JSDelivr mirror.

**File**: [app.ts](file:///private/idata/icoding/projects/singbox/GUI.for.SingBox.git/frontend/src/constant/app.ts)

```typescript
export const DefaultPluginHubSources = () => [
  {
    enable: true,
    name: 'General',
    url: 'https://fastly.jsdelivr.net/gh/GUI-for-Cores/Plugin-Hub@main/plugins/generic.json',
  },
  {
    enable: true,
    name: APP_TITLE,
    url: `https://fastly.jsdelivr.net/gh/GUI-for-Cores/Plugin-Hub@main/plugins/${
      {
        'GUI.for.Clash': 'gfc',
        'GUI.for.SingBox': 'gfs',
      }[APP_TITLE]
    }.json`,
  },
]
```

### 2. Automatic Migration Logic
When the app starts, it should check if the plugin sources are empty or using old blocked URLs, and migrate them to the latest stable mirror.

**File**: [appSettings.ts](file:///private/idata/icoding/projects/singbox/GUI.for.SingBox.git/frontend/src/stores/appSettings.ts)

Inside `setupAppSettings`:

```typescript
if (!settings.plugins || !settings.plugins.sources || settings.plugins.sources.length === 0) {
  settings.plugins = {
    sources: DefaultPluginHubSources(),
  }
} else {
  // Migrate old GitHub Raw or TestingCF URLs to Fastly JSDelivr
  settings.plugins.sources.forEach((source) => {
    if (
      source.url.startsWith('https://raw.githubusercontent.com/GUI-for-Cores/Plugin-Hub/main/plugins/') ||
      source.url.startsWith('https://testingcf.jsdelivr.net/gh/GUI-for-Cores/Plugin-Hub@main/plugins/') ||
      source.url.startsWith('https://github.com/GUI-for-Cores/Plugin-Hub/raw/main/plugins/')
    ) {
      source.url = source.url
        .replace(
          'https://raw.githubusercontent.com/GUI-for-Cores/Plugin-Hub/main/plugins/',
          'https://fastly.jsdelivr.net/gh/GUI-for-Cores/Plugin-Hub@main/plugins/',
        )
        .replace(
          'https://testingcf.jsdelivr.net/gh/GUI-for-Cores/Plugin-Hub@main/plugins/',
          'https://fastly.jsdelivr.net/gh/GUI-for-Cores/Plugin-Hub@main/plugins/',
        )
        .replace(
          'https://github.com/GUI-for-Cores/Plugin-Hub/raw/main/plugins/',
          'https://fastly.jsdelivr.net/gh/GUI-for-Cores/Plugin-Hub@main/plugins/',
        )
    }
  })
}
```

### 3. Error Handling in Plugin Store
Ensure that the `updatePluginHub` function provides meaningful error messages if all sources fail.

**File**: [plugins.ts](file:///private/idata/icoding/projects/singbox/GUI.for.SingBox.git/frontend/src/stores/plugins.ts)

## When to Invoke
- **Upstream Sync**: After merging new changes from the upstream repository to re-apply the mirror patch.
- **Troubleshooting**: When the user reports that the "Plugin Hub" is empty or "Plugin count is 0".
- **Initial Setup**: When setting up a new development environment to ensure plugin accessibility.

## Verification
1. Open **Plugins** -> **Plugin Hub**.
2. Check if the list is populated.
3. Open **Settings** (gear icon) in Plugin Hub and verify the URL starts with `fastly.jsdelivr.net`.
