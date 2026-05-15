<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

import logo from '@/assets/logo'
import {
  WindowSetAlwaysOnTop,
  WindowHide,
  WindowMinimise,
  WindowSetSize,
  WindowToggleMaximise,
  WindowIsMaximised,
  RestartApp,
} from '@/bridge'
import { OS } from '@/enums/app'
import { useAppSettingsStore, useKernelApiStore, useEnvStore, useAppStore } from '@/stores'
import { APP_TITLE, APP_VERSION, debounce, exitApp, reloadApp, message } from '@/utils'

import type { Menu } from '@/types/app'

const isPinned = ref(false)
const isMaximised = ref(false)

const appSettingsStore = useAppSettingsStore()
const kernelApiStore = useKernelApiStore()
const envStore = useEnvStore()
const appStore = useAppStore()

const isDarwin = envStore.env.os === OS.Darwin

const handleRestartKernel = async () => {
  try {
    await kernelApiStore.restartCore()
  } catch (error: any) {
    console.error(error)
    message.error(error)
  }
}

const pinWindow = () => {
  isPinned.value = !isPinned.value
  WindowSetAlwaysOnTop(isPinned.value)
}

const closeWindow = async () => {
  if (appSettingsStore.app.exitOnClose) {
    exitApp()
  } else {
    WindowHide()
  }
}

const menus: Menu[] = [
  {
    label: 'titlebar.resetSize',
    handler: () => WindowSetSize(800, 540),
  },
  {
    label: 'titlebar.reload',
    handler: reloadApp,
  },
  {
    label: 'titlebar.restart',
    handler: RestartApp,
  },
  {
    label: 'titlebar.exitApp',
    handler: exitApp,
  },
]

const onResize = debounce(async () => {
  isMaximised.value = await WindowIsMaximised()
}, 100)

onMounted(() => window.addEventListener('resize', onResize))
onUnmounted(() => window.removeEventListener('resize', onResize))
</script>

<template>
  <div v-menu="menus" class="flex items-center py-8 gap-8 px-12" style="--wails-draggable: drag">
    <img v-if="!isDarwin" class="w-24 h-24" draggable="false" :src="logo" />

    <div
      :class="isDarwin ? 'justify-center py-4 text-12' : 'text-14'"
      :style="{
        color: kernelApiStore.needRestart
          ? '#cf1322'
          : kernelApiStore.running
            ? 'var(--primary-color)'
            : 'var(--color)',
      }"
      class="font-bold w-full h-full flex items-center"
      @dblclick="WindowToggleMaximise"
    >
      {{ APP_TITLE }} {{ APP_VERSION }}
      <span
        v-if="kernelApiStore.needRestart"
        class="ml-8 px-8 py-2 rounded-full text-12"
        style="background: #fff1f0; color: #cf1322; line-height: 1"
      >
        {{ $t('home.overview.restart') }}
      </span>
      <div class="ml-8 flex items-center gap-4" style="--wails-draggable: disabled">
        <Tag v-if="kernelApiStore.needRestart" color="orange" size="small">
          {{ $t('settings.needRestart') }}
        </Tag>
        <Button
          v-if="kernelApiStore.needRestart"
          size="small"
          type="primary"
          class="font-bold"
          style="background: #cf1322; border-color: #cf1322; color: #fff"
          @click.stop="handleRestartKernel"
        >
          {{ $t('home.overview.restart') }}
        </Button>
        <CustomAction :actions="appStore.customActions.title_bar" />
      </div>
      <Icon
        v-if="kernelApiStore.starting || kernelApiStore.stopping || kernelApiStore.restarting"
        :size="14"
        icon="loading"
        class="rotation mx-4"
      />
    </div>

    <div
      v-if="!isDarwin"
      class="ml-auto flex items-center gap-4"
      style="--wails-draggable: disabled"
    >
      <Button type="text" :icon="isPinned ? 'pinFill' : 'pin'" @click.stop="pinWindow" />
      <Button icon="minimize" type="text" @click.stop="WindowMinimise" />
      <Button
        :icon="isMaximised ? 'maximize2' : 'maximize'"
        type="text"
        @click.stop="WindowToggleMaximise"
      />
      <Button
        :class="{ 'hover:!bg-red': appSettingsStore.app.exitOnClose }"
        :loading="appStore.isAppExiting || appStore.isAppReloading"
        icon="close"
        type="text"
        @click.stop="closeWindow"
      />
    </div>
  </div>
</template>
