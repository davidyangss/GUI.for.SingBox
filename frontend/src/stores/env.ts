import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

import { GetEnv } from '@/bridge'
import { OS } from '@/enums/app'
import { useAppSettingsStore, useKernelApiStore } from '@/stores'
import { updateTrayAndMenus, SetSystemProxy, GetSystemProxy } from '@/utils'

import type { AppEnv } from '@/types/app'

export const useEnvStore = defineStore('env', () => {
  const appSettings = useAppSettingsStore()
  const kernelApiStore = useKernelApiStore()

  const env = ref<AppEnv>({
    appName: '',
    appVersion: '',
    basePath: '',
    appPath: '',
    os: '' as OS,
    arch: '',
    isPrivileged: false,
  })

  const systemProxy = ref(false)

  const setupEnv = async () => {
    const _env = await GetEnv()
    let appPath = `${_env.basePath}/${_env.appName}`
    if (_env.os === OS.Windows) {
      appPath = appPath.replaceAll('/', '\\')
    } else if (_env.os === OS.Darwin) {
      appPath = appPath.replace(`/Contents/MacOS/${_env.appName}`, '')
    }
    env.value = { ..._env, appPath }
  }

  const updateSystemProxyStatus = async () => {
    const kernelApiStore = useKernelApiStore()
    const proxyServer = await GetSystemProxy()

    if (!proxyServer) {
      systemProxy.value = false
    } else {
      const { port, 'mixed-port': mixedPort, 'socks-port': socksPort } = kernelApiStore.config
      const ip = appSettings.app.mixInboundIP
      const proxyServerList = [
        `http://${ip}:${port}`,
        `http://${ip}:${mixedPort}`,

        `socks5://${ip}:${mixedPort}`,
        `socks5://${ip}:${socksPort}`,

        `socks=${ip}:${mixedPort}`,
        `socks=${ip}:${socksPort}`,
      ]
      systemProxy.value = proxyServerList.includes(proxyServer)
    }

    return systemProxy.value
  }

  const setSystemProxy = async () => {
    const proxyBypassList = appSettings.app.proxyBypassList
    let proxyPort = kernelApiStore.getProxyPort()

    if (!proxyPort) {
      await kernelApiStore.updateConfig('inbound', undefined)
    }

    proxyPort = kernelApiStore.getProxyPort()

    if (!proxyPort) throw 'home.overview.needPort'

    await SetSystemProxy(
      true,
      appSettings.app.mixInboundIP + ':' + proxyPort.port,
      proxyPort.proxyType,
      proxyBypassList,
    )

    systemProxy.value = true
  }

  const clearSystemProxy = async () => {
    const proxyBypassList = appSettings.app.proxyBypassList
    await SetSystemProxy(false, '', undefined, proxyBypassList)
    systemProxy.value = false
  }

  const switchSystemProxy = async (enable: boolean) => {
    if (enable) await setSystemProxy()
    else await clearSystemProxy()
  }

  watch(systemProxy, updateTrayAndMenus)

  return {
    env,
    setupEnv,
    systemProxy,
    setSystemProxy,
    clearSystemProxy,
    switchSystemProxy,
    updateSystemProxyStatus,
  }
})
