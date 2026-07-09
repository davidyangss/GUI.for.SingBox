---
name: "profile-auto-link-subscription"
description: "Auto-link subscription to profile when creating a profile with the same name as an existing subscription. Invoke when syncing upstream or when manually added profiles should auto-reference same-named subscriptions."
---

# Feature: Auto-Link Same-Named Subscription to Profile

## Problem

When manually creating a profile in "配置/Profile" page with the same name as an existing subscription, the profile's outbounds do not automatically reference that subscription. This differs from the "Quick Start" wizard behavior, which explicitly links the subscription.

**User Impact**:
- Users expect that creating a profile named "BaoMaYun" when a subscription "BaoMaYun" exists would automatically use that subscription's nodes
- Currently they must manually add the subscription reference in the Outbounds configuration step
- This is confusing because the "Quick Start" wizard does this automatically

## Root Cause

**Two-layer problem**:

### Layer 1: `getProfileTemplate()` ignores name
The `getProfileTemplate()` function in `profiles.ts` creates a profile with default empty outbounds. It does not check for same-named subscriptions or auto-link them.

```typescript
// frontend/src/stores/profiles.ts (original)
const getProfileTemplate = (name = ''): IProfile => {
  return {
    id: sampleID(),
    name: name,
    log: Defaults.DefaultLog(),
    experimental: Defaults.DefaultExperimental(),
    inbounds: Defaults.DefaultInbounds(),
    outbounds: Defaults.DefaultOutbounds(),  // ← Always default empty outbounds
    route: Defaults.DefaultRoute(),
    dns: Defaults.DefaultDns(),
    mixin: Defaults.DefaultMixin(),
    script: Defaults.DefaultScript(),
  }
}
```

### Layer 2: `ProfileForm.vue` calls `getProfileTemplate()` with no name

Even after adding auto-link logic to `getProfileTemplate()`, the fix doesn't work because `ProfileForm.vue` calls the function **without a name**:

```typescript
// frontend/src/views/ProfilesView/components/ProfileForm.vue:59
const profile = ref<IProfile>(profilesStore.getProfileTemplate())  // ← no name passed!
```

The name is entered by the user afterward via `v-model`, so the store's auto-link logic never fires:

```html
<!-- Step.Name input — name is set AFTER template creation -->
<Input v-model="profile.name" ... />
```

In contrast, the Quick Start wizard **does** pass the name upfront:
```typescript
// frontend/src/views/HomeView/components/QuickStart.vue:42
const profile = profilesStore.getProfileTemplate(name.value)  // ← name passed correctly

if (profile.outbounds[0] && profile.outbounds[1]) {
  profile.outbounds[0].outbounds.push({ id: sub.id, tag: sub.id, type: 'Subscription' })
  profile.outbounds[1].outbounds.push({ id: sub.id, tag: sub.id, type: 'Subscription' })
}
```

## How Profile-Subscription Linking Works

Profiles link to subscriptions via **outbound references**, not by name matching:

1. **Whole subscription reference**:
   ```typescript
   { id: sub.id, tag: sub.name, type: 'Subscription' }
   ```

2. **Individual node reference**:
   ```typescript
   { id: proxy.id, tag: proxy.tag, type: sub.id }
   ```

During config generation (`generator.ts:126-145`), the system:
- Reads the subscription file from `sub.path` (e.g., `data/subscribes/<subId>.json`)
- Expands all nodes into the profile's outbound configuration

## Fix: Auto-Link Same-Named Subscription

This requires changes in **two files**:

### File 1: `frontend/src/stores/profiles.ts`

#### Step 1: Import is already present (or add it)

```typescript
// Line 8 — ensure useSubscribesStore is imported
import { useAppSettingsStore, useSubscribesStore } from '@/stores'
```

#### Step 2: Modify `getProfileTemplate` function

```typescript
const getProfileTemplate = (name = ''): IProfile => {
  const profile: IProfile = {
    id: sampleID(),
    name: name,
    log: Defaults.DefaultLog(),
    experimental: Defaults.DefaultExperimental(),
    inbounds: Defaults.DefaultInbounds(),
    outbounds: Defaults.DefaultOutbounds(),
    route: Defaults.DefaultRoute(),
    dns: Defaults.DefaultDns(),
    mixin: Defaults.DefaultMixin(),
    script: Defaults.DefaultScript(),
  }

  // Auto-link same-named subscription if exists
  if (name) {
    const subscribesStore = useSubscribesStore()
    const matchedSub = subscribesStore.subscribes.find((s) => s.name === name)

    if (matchedSub && profile.outbounds[0] && profile.outbounds[1]) {
      // Add subscription reference to default select and urltest outbounds
      // This mimics the Quick Start wizard behavior
      const subRef = { id: matchedSub.id, tag: matchedSub.name, type: 'Subscription' }
      profile.outbounds[0].outbounds.push(subRef)
      profile.outbounds[1].outbounds.push(subRef)
    }
  }

  return profile
}
```

**Note**: Call `useSubscribesStore()` **inside** the function, not at module level, to avoid circular dependency issues between Pinia stores.

---

### File 2: `frontend/src/views/ProfilesView/components/ProfileForm.vue`

This is the **critical missing piece**. `ProfileForm.vue` calls `getProfileTemplate()` with no name, then the user types a name via `v-model`. The store-level fix alone doesn't work because the name is unavailable at template creation time.

The fix is to add a `watch` on `profile.value.name` that triggers auto-linking reactively.

#### Step 1: Update imports

```typescript
// Add watch and useSubscribesStore
import { ref, inject, computed, useTemplateRef, watch, type Ref, h } from 'vue'
import { useProfilesStore, useSubscribesStore } from '@/stores'
```

#### Step 2: Add `subscribesStore` reference

```typescript
const profilesStore = useProfilesStore()
const subscribesStore = useSubscribesStore()
```

#### Step 3: Add watcher after profile ref initialization

```typescript
const profile = ref<IProfile>(profilesStore.getProfileTemplate())

// Auto-link same-named subscription when user types a profile name
// Track if auto-link has already been applied to avoid duplicate linking
const autoLinkApplied = ref(false)

watch(
  () => profile.value.name,
  (newName) => {
    // Only auto-link for new profiles (not edits) when name is non-empty
    if (!props.id && newName && !autoLinkApplied.value) {
      const matchedSub = subscribesStore.subscribes.find((s) => s.name === newName)

      if (matchedSub && profile.value.outbounds[0] && profile.value.outbounds[1]) {
        // Check if subscription is already linked to avoid duplicates
        const alreadyLinked = profile.value.outbounds[0].outbounds.some(
          (o) => o.id === matchedSub.id && o.type === 'Subscription'
        )

        if (!alreadyLinked) {
          const subRef = { id: matchedSub.id, tag: matchedSub.name, type: 'Subscription' }
          profile.value.outbounds[0].outbounds.push(subRef)
          profile.value.outbounds[1].outbounds.push(subRef)
          autoLinkApplied.value = true
        }
      }
    }
  }
)
```

### Key Implementation Details

1. **Store fix alone is insufficient**: `ProfileForm.vue` calls `getProfileTemplate()` with no name argument, so the store-level check never fires for manual profile creation

2. **Watcher approach**: React to `profile.value.name` changes in `ProfileForm.vue` — triggers as the user types the name

3. **Only for new profiles**: Guard `!props.id` ensures the watcher does nothing when editing existing profiles

4. **`autoLinkApplied` flag**: Prevents duplicate subscription references if the user types, deletes, and retypes the same name

5. **Duplicate check**: `alreadyLinked` guard as a secondary safety net against double-pushing

6. **Add to both default outbounds**:
   - `profile.outbounds[0]` — default `select` group
   - `profile.outbounds[1]` — default `urltest` group

## Behavior After Fix

### Scenario 1: Create profile with same name as existing subscription
1. User adds subscription "BaoMaYun" in subscriptions page
2. User creates new profile named "BaoMaYun" in profiles page
3. **New behavior**: Profile automatically includes "BaoMaYun" subscription in its select/urltest outbounds
4. When generating config, nodes from "BaoMaYun" subscription are expanded into the outbounds

### Scenario 2: Create profile with no matching subscription
1. User creates new profile named "MyCustomProfile"
2. No subscription exists with that name
3. **Behavior**: Profile created with default empty outbounds (unchanged)

### Scenario 3: Create profile with empty name
1. User creates profile without specifying a name (auto-generated ID)
2. **Behavior**: Profile created with default empty outbounds (unchanged)

## Testing Checklist

After applying this fix, verify:

- [ ] Create subscription "TestSub", then create profile "TestSub" → profile outbounds should reference the subscription
- [ ] Create profile "NonExistent" (no matching subscription) → profile created normally with empty outbounds
- [ ] Create profile without name → profile created normally with generated ID
- [ ] Quick Start wizard still works (should not be affected)
- [ ] Edit existing profile → should not trigger re-linking
- [ ] Generate config with auto-linked profile → nodes should appear in outbounds

## When to Reapply

When syncing a new upstream version of `GUI.for.SingBox`, check if these files have been reverted:

1. `frontend/src/stores/profiles.ts` — ensure `getProfileTemplate()` still has the auto-link logic
2. `frontend/src/views/ProfilesView/components/ProfileForm.vue` — ensure the watcher is present

If upstream modified these files, reapply both changes.

## Build and Install

After applying the fix, rebuild and install:

```bash
# Build for macOS
wails build -platform darwin/amd64

# Install to Applications
cp -R build/bin/GUI.for.SingBox.app /Applications/
```

**Version**: Ensure `bridge/bridge.go` line 31 has the correct version:
```go
AppVersion: "v1.25.4",
```
