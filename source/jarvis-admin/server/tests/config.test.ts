import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

vi.mock('node:os', () => ({
  homedir: () => '/mock-home',
}))

const mockExistsSync = vi.fn()
const mockReadFileSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockMkdirSync = vi.fn()

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
}))

import { loadConfig, savePersistedConfig } from '../src/config.js'

describe('loadConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: no persisted config file
    mockExistsSync.mockReturnValue(false)
  })

  it('loads defaults when no env vars or persisted config', () => {
    const config = loadConfig({})

    expect(config.port).toBe(7711)
    expect(config.authUrl).toBe('')
    expect(config.configServiceUrl).toBe('')
    expect(config.llmProxyUrl).toBe('')
    expect(config.commandCenterUrl).toBe('')
    expect(config.dockerSocket).toBe(process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock')
    expect(config.registryPath).toBeNull()
    expect(config.staticDir).toBeNull()
  })

  it('defaults registryPath to the bundled registry JSON when REGISTRY_PATH is unset but the file exists', () => {
    // Prod ships dist/data/service-registry.json but the generated compose
    // never sets REGISTRY_PATH — the default must find the bundled file so
    // app.registry isn't null (which 503s /api/service-env and hides the
    // Service Credentials panel). Simulate the bundled file being present.
    mockExistsSync.mockImplementation((p: unknown) =>
      String(p).endsWith(join('data', 'service-registry.json')),
    )
    const config = loadConfig({})
    expect(config.registryPath).not.toBeNull()
    expect(config.registryPath).toContain(join('data', 'service-registry.json'))
  })

  it('reads env vars', () => {
    const config = loadConfig({
      PORT: '8080',
      JARVIS_AUTH_BASE_URL: 'http://auth:7701',
      JARVIS_CONFIG_URL: 'http://config:7700',
      JARVIS_LLM_PROXY_URL: 'http://llm:7704',
      JARVIS_COMMAND_CENTER_URL: 'http://cc:7703',
      COMMAND_CENTER_ADMIN_KEY: 'admin-key',
      DOCKER_SOCKET: '/custom/docker.sock',
      REGISTRY_PATH: '/path/to/registry.json',
      STATIC_DIR: '/dist',
    })

    expect(config.port).toBe(8080)
    expect(config.authUrl).toBe('http://auth:7701')
    expect(config.configServiceUrl).toBe('http://config:7700')
    expect(config.llmProxyUrl).toBe('http://llm:7704')
    expect(config.commandCenterUrl).toBe('http://cc:7703')
    expect(config.commandCenterAdminKey).toBe('admin-key')
    expect(config.dockerSocket).toBe('/custom/docker.sock')
    expect(config.registryPath).toBe('/path/to/registry.json')
    expect(config.staticDir).toBe('/dist')
  })

  it('persisted config takes priority over env vars', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        authUrl: 'http://persisted-auth:7701',
        configServiceUrl: 'http://persisted-config:7700',
      }),
    )

    const config = loadConfig({
      JARVIS_AUTH_BASE_URL: 'http://env-auth:7701',
      JARVIS_CONFIG_URL: 'http://env-config:7700',
    })

    expect(config.authUrl).toBe('http://persisted-auth:7701')
    expect(config.configServiceUrl).toBe('http://persisted-config:7700')
  })

  it('handles corrupted persisted config file gracefully', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('not valid json{{{')

    const config = loadConfig({ JARVIS_AUTH_BASE_URL: 'http://fallback:7701' })

    // Falls back to env var since persisted is corrupted
    expect(config.authUrl).toBe('http://fallback:7701')
  })

  it('parses PORT as integer', () => {
    const config = loadConfig({ PORT: '3000' })
    expect(config.port).toBe(3000)
    expect(typeof config.port).toBe('number')
  })

  it('defaults PORT to 7711 when not set', () => {
    const config = loadConfig({})
    expect(config.port).toBe(7711)
  })
})

describe('savePersistedConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
  })

  it('creates .jarvis dir and writes JSON', () => {
    savePersistedConfig({
      authUrl: 'http://auth:7701',
      configServiceUrl: 'http://config:7700',
    })

    expect(mockMkdirSync).toHaveBeenCalledWith(join('/mock-home', '.jarvis'), { recursive: true })
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join('/mock-home', '.jarvis', 'admin.json'),
      expect.stringContaining('"authUrl"'),
    )
  })

  it('merges with existing persisted config', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ authUrl: 'http://old-auth:7701' }),
    )

    savePersistedConfig({ configServiceUrl: 'http://config:7700' })

    const written = mockWriteFileSync.mock.calls[0][1] as string
    const parsed = JSON.parse(written)
    expect(parsed.authUrl).toBe('http://old-auth:7701')
    expect(parsed.configServiceUrl).toBe('http://config:7700')
  })
})
