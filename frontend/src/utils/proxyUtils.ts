let parseFunc: any = null
let produceFunc: any = null
let moduleLoaded = false

const loadModule = async () => {
  if (moduleLoaded) return
  try {
    const moduleUrl = '/proxy-utils.esm.mjs'
    const module = await import(moduleUrl)
    parseFunc = module.parse
    produceFunc = module.produce
    moduleLoaded = true
  } catch (error) {
    console.error('[proxyUtils] Failed to load proxy-utils module:', error)
    throw error
  }
}

export const parseProxies = async (input: string) => {
  await loadModule()
  if (!parseFunc) {
    throw new Error('parse function not available')
  }
  return parseFunc(input)
}

export const produceProxies = async (
  proxies: Record<string, any>[],
  targetFormat: 'singbox' | 'v2ray' | 'clash' = 'singbox',
  targetPlatform: 'internal' | 'external' = 'internal'
) => {
  await loadModule()
  if (!produceFunc) {
    throw new Error('produce function not available')
  }
  return produceFunc(proxies, targetFormat, targetPlatform)
}

export const convertToSingBox = async (proxies: Record<string, any>[]) => {
  const isClashFormat = proxies.some((proxy) => proxy.name && !proxy.tag)
  if (!isClashFormat) {
    return proxies
  }
  const converted = await produceProxies(proxies, 'singbox', 'internal')
  converted.forEach((proxy: Record<string, any>) => {
    delete proxy.domain_resolver
  })
  return converted
}

export const isBase64Format = (proxies: Record<string, any>[]) => {
  return proxies.length === 1 && proxies[0]?.base64
}

export const isClashFormat = (proxies: Record<string, any>[]) => {
  return proxies.some((proxy) => proxy.name && !proxy.tag)
}