import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import {
  getProxies,
  getConfigs,
  setConfigs,
  onLogs,
  onMemory,
  onConnections,
  onTraffic,
  initWebsocket,
  destroyWebsocket,
} from '@/api/kernel'
import {
  ProcessInfo,
  KillProcess,
  ExecBackground,
  ReadFile,
  RemoveFile,
  WindowSetTitle,
  HttpHead,
} from '@/bridge'
import {
  CoreConfigFilePath,
  CoreLogFilePath,
  CorePidFilePath,
  CoreStopOutputKeyword,
} from '@/constant/kernel'
import { DefaultInboundMixed } from '@/constant/profile'
import { Branch } from '@/enums/app'
import { Inbound, RulesetType, TunStack } from '@/enums/kernel'
import {
  useAppSettingsStore,
  useProfilesStore,
  useLogsStore,
  useEnvStore,
  usePluginsStore,
  useSubscribesStore,
  useRulesetsStore,
} from '@/stores'
import {
  generateConfigFile,
  updateTrayAndMenus,
  restoreProfile,
  deepClone,
  message,
  getKernelRuntimeArgs,
  getKernelRuntimeEnv,
  getKernelExecutablePath,
  eventBus,
  APP_TITLE,
  APP_VERSION,
} from '@/utils'
import i18n from '@/lang'

import type { CoreApiConfig, CoreApiProxy } from '@/types/kernel'

export type ProxyType = 'mixed' | 'http' | 'socks'

export const useKernelApiStore = defineStore('kernelApi', () => {
  const envStore = useEnvStore()
  const logsStore = useLogsStore()
  const pluginsStore = usePluginsStore()
  const profilesStore = useProfilesStore()
  const subscribesStore = useSubscribesStore()
  const rulesetsStore = useRulesetsStore()
  const appSettingsStore = useAppSettingsStore()

  /** RESTful API */
  const config = ref<CoreApiConfig>({
    port: 0,
    'mixed-port': 0,
    'socks-port': 0,
    'mix-inbound-ip': '',
    'interface-name': '',
    'allow-lan': false,
    mode: '',
    tun: {
      enable: false,
      stack: '',
      device: '',
    },
  })

  let runtimeProfile: IProfile | undefined

  const proxies = ref<Record<string, CoreApiProxy>>({})
  const tunMode = computed({
    get: () => appSettingsStore.app.kernel.tunMode,
    set: (value: boolean) => {
      appSettingsStore.app.kernel.tunMode = value
    },
  })

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const hasTunInbound = (profile?: IProfile) =>
    !!profile?.inbounds.find((inbound) => inbound.type === Inbound.Tun)

  const getControllerEndpoint = (profile?: IProfile) => {
    const defaultHost = appSettingsStore.app.mixInboundIP || '127.0.0.1'
    const defaultController = `${defaultHost}:20123`
    const controller = profile?.experimental?.clash_api?.external_controller || defaultController
    const [rawHost = defaultHost, rawPort = '20123'] = controller.split(':')
    const host = rawHost && !['0.0.0.0', '::'].includes(rawHost) ? rawHost : defaultHost
    const port = Number(rawPort) || 20123
    return { host, port, url: `http://${host}:${port}` }
  }

  const isControllerReachable = async (url: string) => {
    try {
      await HttpHead(url, {}, { Timeout: 1, Proxy: '' })
      return true
    } catch {
      return false
    }
  }

  const waitForControllerReleased = async (profile?: IProfile, timeout = 2_500) => {
    const { url } = getControllerEndpoint(profile)
    const deadline = Date.now() + timeout

    while (Date.now() < deadline) {
      const reachable = await isControllerReachable(url)
      if (!reachable) return true
      await sleep(250)
    }

    return !(await isControllerReachable(url))
  }

  const isControllerBusyError = (error: unknown) =>
    /address already in use|eaddrinuse/i.test(String(error))

  const startCoreWithRetryOnBusy = async (
    profile: IProfile | undefined,
    controllerProfile: IProfile | undefined,
  ) => {
    const delays = [0, 800, 1_400, 2_200]
    let lastError: unknown

    for (const [index, delay] of delays.entries()) {
      if (delay > 0) {
        logsStore.recordKernelLog(
          `[gui] restart retry #${index} after controller bind is still busy, waiting ${delay}ms`,
        )
        await sleep(delay)
        await waitForControllerReleased(controllerProfile, 4_500)
      }

      try {
        await startCore(profile)
        return
      } catch (error) {
        lastError = error
        if (!isControllerBusyError(error) || index === delays.length - 1) {
          throw error
        }
      }
    }

    throw lastError
  }

  const applyTunModeToProfile = (profile: IProfile) => {
    const tunInbound = profile.inbounds.find((inbound) => inbound.type === Inbound.Tun)
    if (tunInbound) {
      tunInbound.enable = tunMode.value
    }
  }

  const ensureRuntimeProfile = async () => {
    if (runtimeProfile) return runtimeProfile

    const profile = profilesStore.currentProfile
    try {
      const txt = await ReadFile(CoreConfigFilePath)
      runtimeProfile = restoreProfile(JSON.parse(txt))
      if (profile) {
        const _profile = deepClone(profile)
        _profile.inbounds.forEach((inbound) => {
          const runtimeInbound = runtimeProfile?.inbounds.find((v) => v.tag === inbound.tag)
          if (runtimeInbound) {
            runtimeInbound.id = inbound.id
          } else {
            inbound.enable = false
            runtimeProfile?.inbounds.push(inbound)
          }
        })
        runtimeProfile.id = _profile.id
        runtimeProfile.outbounds = _profile.outbounds
        runtimeProfile.experimental = _profile.experimental
        runtimeProfile.dns = _profile.dns
        runtimeProfile.route = _profile.route
        runtimeProfile.mixin = _profile.mixin
        runtimeProfile.script = _profile.script
      }
    } catch {
      runtimeProfile = profile ? deepClone(profile) : undefined
    }

    return runtimeProfile
  }

  const readCorePid = async (fallback = -1) => {
    const pid = await ReadFile(CorePidFilePath).catch(() => String(fallback))
    return Number(pid) || fallback
  }

  const refreshConfig = async () => {
    const _config = await getConfigs()

    config.value = {
      ..._config,
      tun: config.value.tun,
    }

    await ensureRuntimeProfile()
    if (!runtimeProfile) return

    const mixed = runtimeProfile.inbounds.find((v) => v.enable && v.mixed)
    const http = runtimeProfile.inbounds.find((v) => v.enable && v.http)
    const socks = runtimeProfile.inbounds.find((v) => v.enable && v.socks)
    const tun = runtimeProfile.inbounds.find((v) => v.tun)
    config.value['mixed-port'] = mixed?.mixed?.listen.listen_port || 0
    config.value['port'] = http?.http?.listen.listen_port || 0
    config.value['socks-port'] = socks?.socks?.listen.listen_port || 0
    config.value['mix-inbound-ip'] = appSettingsStore.app.mixInboundIP
    config.value['allow-lan'] = [
      mixed?.mixed?.listen.listen,
      http?.http?.listen.listen,
      socks?.socks?.listen.listen,
    ].some((address) => address === '0.0.0.0' || address === '::')

    config.value.tun.enable = !!tun?.enable
    config.value.tun.device = tun?.tun?.interface_name || ''
    config.value.tun.stack = tun?.tun?.stack || ''
    config.value['interface-name'] = runtimeProfile.route.default_interface
  }

  const setTunMode = async (enable: boolean, restartIfRunning = false) => {
    const profile = runtimeProfile || profilesStore.currentProfile
    if (enable && !hasTunInbound(profile)) {
      throw 'home.overview.needTun'
    }

    tunMode.value = enable
    if (running.value && config.value.tun.enable !== enable) {
      useRuntimeProfileOnNextStart = true
      if (restartIfRunning) {
        await restartCore(undefined, true)
      } else {
        suppressAutoRestart = true
        needRestart.value = true
      }
    }
    await envStore.updateSystemProxyStatus()
  }

  const updateConfig = async (field: string, value: any) => {
    if (field === 'mode') {
      await setConfigs({ mode: value })
      await refreshConfig()
      return
    }

    if (field === 'tun') {
      await setTunMode(!!value?.enable)
      return
    }

    await ensureRuntimeProfile()
    if (!runtimeProfile) return
    const profile = runtimeProfile

    const patchInbound = () => {
      const inbound = profile.inbounds.find(
        (v) =>
          (v.type === Inbound.Mixed && v.mixed?.listen.listen_port) ||
          (v.type === Inbound.Http && v.http?.listen.listen_port) ||
          (v.type === Inbound.Socks && v.socks?.listen.listen_port),
      )
      if (!inbound) {
        throw 'home.overview.needPort'
      }
      inbound.enable = true
    }

    const patchInboundPort = (type: 'mixed' | 'socks' | 'http', port: number) => {
      let inbound = profile.inbounds.find((v) => v.type === type)
      if (inbound) {
        inbound[type]!.listen.listen_port = port
      } else {
        const _type = DefaultInboundMixed(appSettingsStore.app.mixInboundIP)!
        _type.listen.listen_port = port
        inbound = {
          id: type + '-in',
          tag: type + '-in',
          type: type,
          enable: true,
          [type]: _type,
        }
        profile.inbounds.push(inbound)
      }
      inbound.enable = port !== 0
    }

    const patchInboundAddress = (allowLan: boolean) => {
      profile.inbounds.forEach((inbound) => {
        if (inbound.type === Inbound.Tun) return
        inbound[inbound.type]!.listen.listen = allowLan
          ? '0.0.0.0'
          : appSettingsStore.app.mixInboundIP
      })
    }

    const patchInboundListen = (ip: string) => {
      appSettingsStore.app.mixInboundIP = ip
      profile.inbounds.forEach((inbound) => {
        if (inbound.type === Inbound.Tun) return
        if (inbound[inbound.type]!.listen.listen !== '0.0.0.0') {
          inbound[inbound.type]!.listen.listen = ip
        }
      })
    }

    const patchInboundTun = (options: {
      enable: boolean
      stack: string
      device: string
      interface_name: string
    }) => {
      const inbound = profile.inbounds.find((v) => v.type === Inbound.Tun)
      if (!inbound) throw 'home.overview.needTun'
      options = { ...config.value.tun, ...options }
      inbound.enable = options.enable
      inbound.tun!.stack = options.stack || TunStack.Mixed
      inbound.tun!.interface_name = options.device || ''
      if (options.interface_name) {
        profile.route.default_interface = options.interface_name
      }
      profile.route.auto_detect_interface = !options.interface_name
    }

    const fieldHandlerMap: Recordable<() => void> = {
      inbound: () => patchInbound(),
      http: () => patchInboundPort(Inbound.Http, value),
      socks: () => patchInboundPort(Inbound.Socks, value),
      mixed: () => patchInboundPort(Inbound.Mixed, value),
      'mix-inbound-ip': () => patchInboundListen(value),
      'allow-lan': () => patchInboundAddress(value),
      tun: () => patchInboundTun(value),
      'tun-stack': () => patchInboundTun(value),
      'tun-device': () => patchInboundTun(value),
      'interface-name': () => patchInboundTun(value),
    }

    fieldHandlerMap[field]?.()

    if (running.value) {
      suppressAutoRestart = true
      useRuntimeProfileOnNextStart = true
      needRestart.value = true
    } else {
      await startCore(runtimeProfile)
    }
    await envStore.updateSystemProxyStatus()
  }

  const refreshProviderProxies = async () => {
    const { proxies: b } = await getProxies()
    proxies.value = b
  }

  const updateWindowTitle = () => {
    const restartSuffix = needRestart.value ? ` [${i18n.global.t('home.overview.restart')}]` : ''
    WindowSetTitle(`${APP_TITLE} ${APP_VERSION}${restartSuffix}`)
  }

  /* Bridge API */
  const corePid = ref(-1)
  const running = ref(false)
  const starting = ref(false)
  const stopping = ref(false)
  const restarting = ref(false)
  const needRestart = ref(false)
  const restartPromptSource = ref<'default' | 'tray'>('default')
  const coreStateLoading = ref(true)
  let suppressAutoRestart = false
  let useRuntimeProfileOnNextStart = false
  let isCoreStartedByThisInstance = false
  let { promise: coreStoppedPromise, resolve: coreStoppedResolver } = Promise.withResolvers()

  const initCoreState = async () => {
    corePid.value = Number(await ReadFile(CorePidFilePath).catch(() => -1))
    const processName = corePid.value === -1 ? '' : await ProcessInfo(corePid.value).catch(() => '')
    running.value = processName.startsWith('sing-box')

    coreStateLoading.value = false

    if (running.value) {
      initWebsocket()
      await Promise.all([refreshConfig(), refreshProviderProxies()])
      await envStore.updateSystemProxyStatus()
    } else if (appSettingsStore.app.autoStartKernel) {
      await startCore()
    }
  }

  const runCoreProcess = async (isAlpha: boolean) => {
    const corePath = await getKernelExecutablePath(isAlpha)
    const shouldStartWithTun = tunMode.value
    const useAdminLaunch = envStore.env.os === 'darwin' && shouldStartWithTun
    const extractCoreStartError = (content: string) => {
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

      const matchers = [
        /FATAL/i,
        /\bERROR\b/i,
        /permission denied/i,
        /operation not permitted/i,
        /timed out/i,
        /timeout/i,
        /unexpectedly/i,
        /failed/i,
        /canceled/i,
        /cancelled/i,
      ]

      for (const matcher of matchers) {
        const matched = [...lines].reverse().find((line) => matcher.test(line))
        if (matched) return matched
      }

      return ''
    }

    const getCoreStartError = async (fallback?: string) => {
      const logOutput = await ReadFile(CoreLogFilePath).catch(() => '')
      return (
        extractCoreStartError(logOutput) ||
        extractCoreStartError(fallback || '') ||
        fallback ||
        'The core exited unexpectedly'
      )
    }

    logsStore.recordKernelLog(
      `[gui] launch core: tunMode=${shouldStartWithTun} admin=${useAdminLaunch} os=${envStore.env.os}`,
    )

    const waitForCoreReady = async (fallbackPid: number) => {
      let stableAliveCount = 0
      let latestAlivePid = fallbackPid
      const deadline = Date.now() + 10_000

      while (Date.now() < deadline) {
        const pid = await readCorePid(fallbackPid)
        const processName = pid > 0 ? await ProcessInfo(pid).catch(() => '') : ''
        if (processName.startsWith('sing-box')) {
          stableAliveCount += 1
          latestAlivePid = pid

          const output = await ReadFile(CoreLogFilePath).catch(() => '')
          if (output.includes(CoreStopOutputKeyword) || stableAliveCount >= 3) {
            return pid
          }
        } else {
          stableAliveCount = 0
        }

        await sleep(300)
      }

      if (latestAlivePid > 0) {
        return latestAlivePid
      }

      throw await getCoreStartError('Start core timeout')
    }

    return new Promise<number>((resolve, reject) => {
      let output = ''
      let settled = false
      let startedPid = -1

      const resolveOnce = (pid: number) => {
        if (settled) return
        settled = true
        resolve(pid)
      }

      const rejectOnce = (error: any) => {
        if (settled) return
        settled = true
        reject(error)
      }

      ExecBackground(
        corePath,
        getKernelRuntimeArgs(isAlpha),
        (out) => {
          output = out
          logsStore.recordKernelLog(out)
          if (out.includes(CoreStopOutputKeyword)) {
            readCorePid(startedPid)
              .then((pid) => resolveOnce(pid > 0 ? pid : startedPid))
              .catch(() => resolveOnce(startedPid))
          }
        },
        () => {
          void getCoreStartError(output).then((error) => {
            onCoreStopped()
            rejectOnce(error)
          })
        },
        {
          PidFile: CorePidFilePath,
          LogFile: CoreLogFilePath,
          StopOutputKeyword: CoreStopOutputKeyword,
          Env: getKernelRuntimeEnv(isAlpha),
          Admin: useAdminLaunch,
        },
      )
        .then((pid) => {
          startedPid = pid
          waitForCoreReady(pid)
            .then(resolveOnce)
            .catch(rejectOnce)
        })
        .catch(rejectOnce)
    })
  }

  const onCoreStarted = async (pid: number) => {
    corePid.value = pid
    running.value = true
    needRestart.value = false
    restartPromptSource.value = 'default'
    useRuntimeProfileOnNextStart = false
    isCoreStartedByThisInstance = true
    coreStoppedPromise = new Promise((r) => (coreStoppedResolver = r))

    initWebsocket()
    await Promise.all([refreshConfig(), refreshProviderProxies()])

    if (appSettingsStore.app.autoSetSystemProxy) {
      await envStore.setSystemProxy().catch((err) => message.error(err))
    }
    await envStore.updateSystemProxyStatus()

    await pluginsStore.onCoreStartedTrigger()
  }

  const onCoreStopped = async () => {
    if (!isCoreStartedByThisInstance) {
      await RemoveFile(CorePidFilePath)
    }

    corePid.value = -1
    running.value = false
    needRestart.value = false
    restartPromptSource.value = 'default'
    useRuntimeProfileOnNextStart = false

    destroyWebsocket()

    await envStore.updateSystemProxyStatus()
    if (envStore.systemProxy) {
      await envStore.clearSystemProxy()
    }
    await pluginsStore.onCoreStoppedTrigger()

    coreStoppedResolver(null)
  }

  const waitForCoreStopped = async () => {
    if (!isCoreStartedByThisInstance) {
      await onCoreStopped()
      return
    }

    const result = await Promise.race([
      coreStoppedPromise.then(() => 'event'),
      sleep(1_500).then(() => 'timeout'),
    ])
    if (result === 'event') return

    const processName = corePid.value > 0 ? await ProcessInfo(corePid.value).catch(() => '') : ''
    if (!processName.startsWith('sing-box')) {
      await onCoreStopped()
      return
    }

    throw 'Failed to stop core process'
  }

  const startCore = async (_profile?: IProfile) => {
    if (running.value) throw 'The core is already running'

    logsStore.clearKernelLog()
    await Promise.all([
      RemoveFile(CorePidFilePath).catch(() => undefined),
      RemoveFile(CoreLogFilePath).catch(() => undefined),
    ])

    const { profile: profileID, branch } = appSettingsStore.app.kernel
    const sourceProfile = _profile || profilesStore.getProfileById(profileID)
    if (!sourceProfile) throw 'Choose a profile first'

    const profile = deepClone(sourceProfile)
    if (tunMode.value && !hasTunInbound(profile)) {
      throw 'home.overview.needTun'
    }
    applyTunModeToProfile(profile)

    if (!_profile) {
      runtimeProfile = undefined
    }

    starting.value = true
    try {
      await generateConfigFile(profile, (config) =>
        pluginsStore.onBeforeCoreStartTrigger(config, profile),
      )
      const isAlpha = branch === Branch.Alpha
      const pid = await runCoreProcess(isAlpha)
      pid && (await onCoreStarted(pid))
    } finally {
      starting.value = false
    }
  }

  const stopCore = async () => {
    if (!running.value) throw 'The core is not running'

    stopping.value = true
    try {
      await pluginsStore.onBeforeCoreStopTrigger()
      await KillProcess(corePid.value)
      await waitForCoreStopped()
    } finally {
      stopping.value = false
    }
  }

  const restartCore = async (cleanupTask?: () => Promise<any>, keepRuntimeProfile = false) => {
    restarting.value = true
    try {
      const shouldKeepRuntimeProfile = keepRuntimeProfile || useRuntimeProfileOnNextStart
      const activeProfile = runtimeProfile || profilesStore.currentProfile
      const switchingOffTun = config.value.tun.enable && !tunMode.value
      await stopCore()
      if (switchingOffTun) {
        // Give macOS a moment to fully release the previous TUN runtime artifacts.
        await sleep(600)
      }
      await waitForControllerReleased(activeProfile)
      await cleanupTask?.()
      await startCoreWithRetryOnBusy(
        shouldKeepRuntimeProfile ? runtimeProfile : undefined,
        activeProfile,
      )
    } finally {
      needRestart.value = false
      restartPromptSource.value = 'default'
      restarting.value = false
    }
  }

  const emphasizeRestartPrompt = (source: 'default' | 'tray' = 'default') => {
    if (!needRestart.value) return
    restartPromptSource.value = source
    updateWindowTitle()
  }

  const getProxyPort = ():
    | {
        port: number
        proxyType: ProxyType
      }
    | undefined => {
    const { port, 'socks-port': socksPort, 'mixed-port': mixedPort } = config.value

    if (mixedPort) {
      return {
        port: mixedPort,
        proxyType: 'mixed',
      }
    }
    if (port) {
      return {
        port,
        proxyType: 'http',
      }
    }
    if (socksPort) {
      return {
        port: socksPort,
        proxyType: 'socks',
      }
    }
    return undefined
  }

  eventBus.on('profileChange', ({ id }) => {
    if (running.value && id === appSettingsStore.app.kernel.profile) {
      needRestart.value = true
    }
  })

  eventBus.on('subscriptionChange', ({ id }) => {
    if (running.value && profilesStore.currentProfile) {
      const inUse = profilesStore.currentProfile.outbounds.some(({ outbounds }) =>
        outbounds.some((outbound) => outbound.type === 'Subscription' && outbound.id === id),
      )
      if (inUse) {
        needRestart.value = true
      }
    }
  })

  eventBus.on('subscriptionsChange', () => {
    if (running.value && profilesStore.currentProfile) {
      const enabledSubs = subscribesStore.subscribes.flatMap((v) => (v.disabled ? [] : v.id))
      const inUse = profilesStore.currentProfile.outbounds.some(({ outbounds }) =>
        outbounds.some(
          (outbound) => outbound.type === 'Subscription' && enabledSubs.includes(outbound.id),
        ),
      )
      if (inUse) {
        needRestart.value = true
      }
    }
  })

  const collectRulesetIDs = () => {
    if (!profilesStore.currentProfile) return []
    const l1 = profilesStore.currentProfile.route.rule_set.flatMap((ruleset) =>
      ruleset.type === RulesetType.Local ? ruleset.path : [],
    )
    return l1
  }

  eventBus.on('rulesetChange', ({ id }) => {
    if (running.value && profilesStore.currentProfile) {
      const inUse = profilesStore.currentProfile.route.rule_set.some(
        (ruleset) => ruleset.type === RulesetType.Local && ruleset.path === id,
      )
      if (inUse) {
        needRestart.value = true
      }
    }
  })

  eventBus.on('rulesetsChange', () => {
    if (running.value && profilesStore.currentProfile) {
      const enabledRulesets = rulesetsStore.rulesets.flatMap((v) => (v.disabled ? [] : v.id))
      const inUse = collectRulesetIDs().some((v) => enabledRulesets.includes(v))
      if (inUse) {
        needRestart.value = true
      }
    }
  })

  watch(
    needRestart,
    (v, oldV) => {
      updateWindowTitle()
      if (v && !oldV && running.value) {
        message.info('home.overview.manualRestartCore', 5_000)
      }
      if (!v) {
        restartPromptSource.value = 'default'
        suppressAutoRestart = false
        return
      }
      if (suppressAutoRestart) {
        suppressAutoRestart = false
        return
      }
      if (appSettingsStore.app.autoRestartKernel) {
        restartCore()
      }
    },
    { immediate: true },
  )

  const watchSources = computed(() => {
    const source = [config.value.mode, config.value.tun.enable, tunMode.value, needRestart.value]
    if (!appSettingsStore.app.addGroupToMenu) return source.join('')

    const { unAvailable, sortByDelay } = appSettingsStore.app.kernel

    const proxySignature = Object.values(proxies.value)
      .map((group) => group.name + group.now)
      .sort()
      .join()

    return source.concat([proxySignature, unAvailable, sortByDelay]).join('')
  })

  watch([watchSources, running], updateTrayAndMenus)

  return {
    startCore,
    stopCore,
    restartCore,
    setTunMode,
    initCoreState,
    pid: corePid,
    running,
    starting,
    stopping,
    restarting,
    needRestart,
    restartPromptSource,
    coreStateLoading,
    config,
    tunMode,
    proxies,
    refreshConfig,
    updateConfig,
    refreshProviderProxies,
    getProxyPort,
    emphasizeRestartPrompt,

    onLogs,
    onMemory,
    onTraffic,
    onConnections,
  }
})
