<script setup lang="ts">
import { ref, inject, h } from 'vue'
import { useI18n } from 'vue-i18n'

import { ReadFile, WriteFile } from '@/bridge'
import { useProfilesStore, useSubscribesStore } from '@/stores'
import { message, restoreProfile, sampleID } from '@/utils'

import Button from '@/components/Button/index.vue'

const ProxyOutboundTypes = [
  'vless',
  'vmess',
  'trojan',
  'shadowsocks',
  'shadowsocksr',
  'hysteria',
  'hysteria2',
  'tuic',
  'wireguard',
  'ssh',
  'socks',
  'http',
]

const { t } = useI18n()
const subscribeStore = useSubscribesStore()
const profilesStore = useProfilesStore()

const loading = ref(false)
const name = ref('')
const inputMode = ref<'paste' | 'file'>('paste')
const jsonContent = ref('')
const filePath = ref('')

const handleCancel = inject('cancel') as any
const handleSubmit = inject('submit') as any

const parseConfig = (raw: string): Recordable => {
  const config = JSON.parse(raw)
  if (!config || typeof config !== 'object') {
    throw new Error(t('importClientConfig.invalidConfig'))
  }
  return config
}

const extractProxies = (config: Recordable): Recordable[] => {
  const outbounds = config.outbounds
  if (!Array.isArray(outbounds) || outbounds.length === 0) {
    throw new Error(t('importClientConfig.noOutbounds'))
  }
  const proxies = outbounds.filter((o: Recordable) => ProxyOutboundTypes.includes(o.type))
  if (proxies.length === 0) {
    throw new Error(t('importClientConfig.noProxyOutbounds'))
  }
  return proxies
}

const handleImport = async () => {
  loading.value = true

  try {
    let raw: string
    if (inputMode.value === 'file') {
      if (!filePath.value.trim()) {
        throw new Error(t('importClientConfig.filePathRequired'))
      }
      raw = await ReadFile(filePath.value.trim())
    } else {
      if (!jsonContent.value.trim()) {
        throw new Error(t('importClientConfig.contentRequired'))
      }
      raw = jsonContent.value
    }

    const config = parseConfig(raw)
    const proxies = extractProxies(config)

    const subName = name.value || 'client-config'
    const sub = subscribeStore.getSubscribeTemplate(subName)
    sub.type = 'Manual'
    sub.url = ''

    await subscribeStore.addSubscribe(sub)

    try {
      await WriteFile(sub.path, JSON.stringify(proxies, null, 2))
      await subscribeStore.updateSubscribe(sub.id)
    } catch (e: any) {
      await subscribeStore.deleteSubscribe(sub.id).catch(() => {})
      throw e
    }

    const profileName = name.value || 'client-config'
    const profile = restoreProfile(config, profileName, { subscriptionIds: [sub.id] })

    const hasSelectorOrUrltest = profile.outbounds.some(
      (o) => o.type === 'selector' || o.type === 'urltest',
    )
    if (hasSelectorOrUrltest) {
      for (const outbound of profile.outbounds) {
        if (outbound.type === 'selector' || outbound.type === 'urltest') {
          const hasSubRef = outbound.outbounds.some((o) => o.type === sub.id)
          if (!hasSubRef) {
            outbound.outbounds.unshift({ id: sub.id, type: 'Subscription', tag: sub.name })
          }
        }
      }
    } else {
      const selectorOutbound = {
        id: sampleID(),
        tag: t('outbound.select'),
        type: 'selector' as const,
        outbounds: [
          { id: sub.id, type: 'Subscription', tag: sub.name },
          { id: 'direct', type: 'Built-in', tag: 'direct' },
          { id: 'block', type: 'Built-in', tag: 'block' },
        ],
        interrupt_exist_connections: true,
        url: '',
        interval: '3m',
        tolerance: 150,
        include: '',
        exclude: '',
        icon: '',
        hidden: false,
      }
      profile.outbounds.unshift(selectorOutbound as any)
      profile.route.final = selectorOutbound.id
    }

    await profilesStore.addProfile(profile)

    message.success('importClientConfig.success')
    handleSubmit()
  } catch (error: any) {
    console.error('importClientConfig:', error)
    message.error(error.message || error)
  }

  loading.value = false
}

const modalSlots = {
  cancel: () =>
    h(
      Button,
      {
        disabled: loading.value,
        onClick: handleCancel,
      },
      () => t('common.cancel'),
    ),
  submit: () =>
    h(
      Button,
      {
        type: 'primary',
        loading: loading.value,
        onClick: handleImport,
      },
      () => t('common.import'),
    ),
}

defineExpose({ modalSlots })
</script>

<template>
  <div>
    <div class="form-item">
      {{ t('subscribe.name') }}
      <div class="min-w-[75%]">
        <Input v-model="name" placeholder="client-config" class="w-full" />
      </div>
    </div>
    <div class="form-item">
      {{ t('importClientConfig.inputMode') }}
      <Radio
        v-model="inputMode"
        :options="[
          { label: 'importClientConfig.paste', value: 'paste' },
          { label: 'importClientConfig.file', value: 'file' },
        ]"
      />
    </div>
    <div v-if="inputMode === 'file'" class="form-item">
      {{ t('importClientConfig.filePath') }}
      <div class="min-w-[75%]">
        <Input
          v-model="filePath"
          :placeholder="t('importClientConfig.filePathPlaceholder')"
          class="w-full"
          allow-paste
        />
      </div>
    </div>
    <div v-else class="flex flex-col gap-4 mt-8">
      <div class="text-xs opacity-70">{{ t('importClientConfig.pastePlaceholder') }}</div>
      <textarea
        v-model="jsonContent"
        :placeholder="t('importClientConfig.jsonPlaceholder')"
        class="json-textarea"
        rows="16"
        spellcheck="false"
      />
    </div>
  </div>
</template>

<style scoped>
.json-textarea {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-color);
  color: var(--text-color);
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  tab-size: 2;
}

.json-textarea:focus {
  border-color: var(--primary-color);
}
</style>
