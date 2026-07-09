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

The `getProfileTemplate()` function in `profiles.ts` creates a profile with default empty outbounds. It does not check for same-named subscriptions or auto-link them.

**Code evidence**:
```typescript
// frontend/src/stores/profiles.ts:71-84
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

In contrast, the Quick Start wizard explicitly links the subscription:
```typescript
// frontend/src/views/HomeView/components/QuickStart.vue:42-47
const profile = profilesStore.getProfileTemplate(name.value)

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

### Step 1: Update imports in profiles.ts

```typescript
// Add at the top of the file
import { useSubscribesStore } from '@/stores'
```

**Note**: Since this is a Pinia store and we're inside another Pinia store, we need to call `useSubscribesStore()` inside the function, not at module level.

### Step 2: Modify getProfileTemplate function

Replace the `getProfileTemplate` function:

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

### Key Implementation Details

1. **Only auto-link when name is provided**: If `name` is empty, skip the lookup (respects existing behavior for unnamed profiles)

2. **Match by subscription name**: Uses `subscribes.find(s => s.name === name)` to locate the subscription

3. **Add to both default outbounds**: 
   - `profile.outbounds[0]` is the default `select` group
   - `profile.outbounds[1]` is the default `urltest` group
   - This matches Quick Start wizard behavior

4. **Safe access checks**: Verifies `profile.outbounds[0]` and `profile.outbounds[1]` exist before pushing references

5. **Reference format**: Uses `type: 'Subscription'` to indicate a whole-subscription reference (vs individual node references which use `type: sub.id`)

### Step 3: No import changes needed at top level

The import of `useSubscribesStore` can be added alongside the existing store imports:

```typescript
import { useAppSettingsStore } from '@/stores'
```

becomes:

```typescript
import { useAppSettingsStore, useSubscribesStore } from '@/stores'
```

However, note that we call `useSubscribesStore()` **inside** the `getProfileTemplate` function, not at the module level, to avoid circular dependency issues between Pinia stores.

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

When syncing a new upstream version of `GUI.for.SingBox`, check if `frontend/src/stores/profiles.ts` still has the basic `getProfileTemplate` without auto-linking logic. If upstream reverted or modified the function, reapply this enhancement.

## Alternative: UI-Level Auto-Link

If modifying the store feels too invasive, an alternative approach is to add the auto-link logic at the UI level in `ProfileForm.vue`:

```typescript
// In ProfileForm.vue, when opening the form for a new profile
const handleShowProfileForm = (name: string) => {
  const profile = profilesStore.getProfileTemplate(name)
  
  // Auto-link same-named subscription
  if (name) {
    const matchedSub = subscribesStore.subscribes.find(s => s.name === name)
    if (matchedSub && profile.outbounds[0] && profile.outbounds[1]) {
      const subRef = { id: matchedSub.id, tag: matchedSub.name, type: 'Subscription' }
      profile.outbounds[0].outbounds.push(subRef)
      profile.outbounds[1].outbounds.push(subRef)
    }
  }
  
  return profile
}
```

However, the store-level approach is cleaner because:
- Centralizes the logic in one place
- Ensures consistency across all profile creation paths
- Matches the architectural pattern of Quick Start wizard
