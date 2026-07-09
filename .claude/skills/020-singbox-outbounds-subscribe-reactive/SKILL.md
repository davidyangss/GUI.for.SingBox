---
name: "singbox-outbounds-subscribe-reactive"
description: "Fixes OutboundsConfig.vue not showing new subscriptions in proxy selection list. Invoke when syncing upstream and reapplying the reactive subscription watch patch, or when added subscriptions don't appear in profile outbound config."
---

# Fix: OutboundsConfig Subscription List Not Reactive

## Problem

In `frontend/src/views/ProfilesView/components/OutboundsConfig.vue`, the `proxyGroup` subscription data was populated via a one-time `forEach` at component initialization. When `subscribesStore.subscribes` changed (adding/deleting/updating subscriptions), `proxyGroup` did not update, so new subscriptions never appeared in the profile outbound proxy selection list.

## Root Cause

The original code used `forEach` to push subscription data into `proxyGroup`:

```js
subscribesStore.subscribes.forEach(async ({ id, name, proxies }) => {
  proxyGroup.value[1]!.proxies.push({ id, tag: name, type: 'Subscribe' })
  proxyGroup.value.push({ id, name, proxies })
  SubscribesNameMap.value[id] = name
})
```

`forEach` runs once at setup. It has no reactive binding to `subscribesStore.subscribes`, so subsequent changes are invisible to `proxyGroup`.

## Failed Attempts

Two earlier attempts were tried and failed:

1. **`watch` with `deep: true`**: Deep watching a Pinia setup store's `ref` array proved unreliable for detecting nested property mutations (`s.proxies = [...]`).
2. **`watch(.length) + eventBus`**: The `watch` on `.length` did not reliably trigger in the Pinia setup store context; `addSubscribe` does not emit `subscriptionChange`.

## Fix (Final): Use Vue `computed`

The reliable solution is to change `proxyGroup` from a `ref` with manual updates to a **Vue `computed`**. A computed property automatically re-evaluates whenever any of its reactive dependencies (`model.value`, `subscribesStore.subscribes`) change. This eliminates the need for watchers, eventBus listeners, and manual proxyGroup mutations entirely.

### Step 1: Update imports

```js
// Before
import { onUnmounted, ref, watch } from 'vue'
import { deepClone, eventBus, message } from '@/utils'

// After
import { computed, ref } from 'vue'
import { deepClone, message } from '@/utils'
```

### Step 2: Change proxyGroup from `ref` to `computed`

```js
// REMOVE:
const SubscribesNameMap = ref<Record<string, string>>({})

const proxyGroup = ref([
  {
    id: 'Built-in',
    name: 'kernel.outbounds.builtIn',
    proxies: [
      ...BuiltInOutbound.map((v) => ({ id: v, tag: v, type: 'Built-In' })),
      ...model.value.map(({ id, tag, type }) => ({ id, tag, type: type as string })),
    ],
  },
  {
    id: 'Subscription',
    name: 'kernel.outbounds.subscriptions',
    proxies: [],
  },
])

// ADD:
const proxyGroup = computed(() => [
  {
    id: 'Built-in',
    name: 'kernel.outbounds.builtIn',
    proxies: [
      ...BuiltInOutbound.map((v) => ({ id: v, tag: v, type: 'Built-In' })),
      ...model.value.map(({ id, tag, type }) => ({ id, tag, type: type as string })),
    ],
  },
  {
    id: 'Subscription',
    name: 'kernel.outbounds.subscriptions',
    proxies: subscribesStore.subscribes.map(({ id, name }) => ({ id, tag: name, type: 'Subscribe' })),
  },
  ...subscribesStore.subscribes.map(({ id, name, proxies }) => ({ id, name, proxies })),
])
```

`SubscribesNameMap` is removed entirely — it was unused.

### Step 3: Simplify handleDeleteGroup

Remove the redundant `proxyGroup` mutation — `model.value.splice()` already updates `model`, and the `computed` picks it up:

```js
// REMOVE:
const handleDeleteGroup = (index: number) => {
  const id = model.value[index]!.id
  model.value.splice(index, 1)
  proxyGroup.value = proxyGroup.value.map((v) => ({
    ...v,
    proxies: v.proxies.filter((v) => v.id !== id),
  }))
}

// REPLACE WITH:
const handleDeleteGroup = (index: number) => {
  model.value.splice(index, 1)
}
```

### Step 4: Simplify handleAddEnd

Remove the redundant `proxyGroup` mutations — `model.value` operations already update the model, and the `computed` picks it up:

```js
// REMOVE:
const handleAddEnd = () => {
  const { id, tag, type } = fields.value
  // Add
  if (updateGroupId === -1) {
    model.value.unshift(fields.value)
    proxyGroup.value[0]!.proxies.unshift({ id, tag, type })
    return
  }
  // Update
  model.value[updateGroupId] = fields.value
  const idx = proxyGroup.value[0]!.proxies.findIndex((v) => v.id === id)
  if (idx !== -1) {
    proxyGroup.value[0]!.proxies.splice(idx, 1, { id, tag, type })
    model.value
      .filter(...)
      .forEach(...)
  }
}

// REPLACE WITH:
const handleAddEnd = () => {
  const { id, tag } = fields.value
  if (updateGroupId === -1) {
    model.value.unshift(fields.value)
    return
  }
  model.value[updateGroupId] = fields.value
  model.value
    .filter((outbound) => [Outbound.Selector, Outbound.Urltest].includes(outbound.type as any))
    .forEach(({ outbounds }) => {
      const proxy = outbounds.find((v) => v.id === id)
      proxy && (proxy.tag = tag)
    })
}
```

Note: the `type` field from `fields.value` is no longer destructured since it's only used in the old `proxyGroup` mutation.

### Step 5: Remove the watch/eventBus/rebuildProxyGroup/onUnmounted block

The entire block is no longer needed since `computed` handles reactivity automatically:

```js
// REMOVE the entire block:
const rebuildProxyGroup = () => { ... }
watch(() => subscribesStore.subscribes.length, rebuildProxyGroup, { immediate: true })
eventBus.on('subscriptionChange', rebuildProxyGroup)
onUnmounted(() => { eventBus.off('subscriptionChange', rebuildProxyGroup) })
```

### Key details

- **`computed` is inherently reactive**: Any change to `model.value` (the profile's outbounds array) or `subscribesStore.subscribes` (the subscriptions array) automatically triggers re-evaluation.
- **No manual mutations needed**: Since the computed rebuilds `proxyGroup` from scratch using `model.value` and `subscribesStore.subscribes`, all the old `proxyGroup.value = [...]`, `.unshift()`, `.splice()`, `.map()` mutations are redundant and removed.
- **Template compatibility**: `computed` refs auto-unwrap in Vue templates, so `v-for="group in proxyGroup"` works without `.value`.
- **`SubscribesNameMap` removed**: It was never read anywhere — only written to in the old `forEach` and `rebuildProxyGroup`.

## When to Reapply

When syncing a new upstream version of `GUI.for.SingBox`, check if `OutboundsConfig.vue` still uses the `forEach` pattern or `ref` for `proxyGroup`. If upstream reverted the fix, reapply this patch.
