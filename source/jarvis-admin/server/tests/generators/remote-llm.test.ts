import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateCompose, getComposeServices } from '../../src/services/generators/compose-generator.js'
import { generateEnv } from '../../src/services/generators/env-generator.js'
import { parseRegistry } from '../../src/services/generators/service-registry.js'
import type { ServiceRegistry } from '../../src/types/service-registry.js'
import type { WizardState } from '../../src/types/wizard.js'

function loadRegistry(): ServiceRegistry {
  const raw = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../src/data/service-registry.json'), 'utf-8'),
  )
  return parseRegistry(raw)
}

function makePi5State(): WizardState {
  return {
    currentStep: 0,
    totalSteps: 7,
    enabledModules: ['jarvis-whisper-api', 'jarvis-tts', 'jarvis-notifications'],
    portOverrides: {},
    infraPortOverrides: {},
    secrets: {},
    dbUser: 'jarvis',
    whisperModel: 'base.en',
    whisperModelPath: '/whisper-models/ggml-base.en.bin',
    llmInterface: 'Qwen25MediumUntrained',
    deploymentMode: 'remote-llm',
    deploymentTarget: 'standard',
    remoteLlmUrl: 'http://192.168.1.100:7704',
    remoteWhisperUrl: 'http://192.168.1.100:7706',
    platform: 'linux',
    hardware: {
      platform: 'linux',
      arch: 'aarch64',
      totalMemoryGb: 8,
      gpuName: null,
      gpuVramMb: null,
      gpuType: 'none',
      recommendedBackends: ['gguf'],
      recommendedBackend: 'remote',
    },
    relayEnabled: false,
    relayUrl: '',
    releaseTrack: 'stable',
    nativeServices: [],
  }
}

describe('Remote LLM (Pi 5) deployment', () => {
  const registry = loadRegistry()

  it('excludes llm-proxy from compose services', () => {
    const state = makePi5State()
    // llm-proxy is nativeOnly=true but platform is linux, so it should be included
    // unless we manually don't add it to enabledModules
    const services = getComposeServices(state, registry)
    const ids = services.map((s) => s.id)
    // llm-proxy-api is not in enabledModules, so it shouldn't appear
    expect(ids).not.toContain('jarvis-llm-proxy-api')
  })

  it('generates compose with remote LLM/whisper URLs in command-center', () => {
    const state = makePi5State()
    const compose = generateCompose(state, registry)

    expect(compose).toContain('JARVIS_LLM_PROXY_URL: http://192.168.1.100:7704')
    expect(compose).toContain('JARVIS_WHISPER_URL: http://192.168.1.100:7706')
  })

  it('generates .env with remote URLs', () => {
    const state = makePi5State()
    const env = generateEnv(state, registry)

    expect(env).toContain('JARVIS_LLM_PROXY_URL=http://192.168.1.100:7704')
    expect(env).toContain('JARVIS_WHISPER_URL=http://192.168.1.100:7706')
  })

  it('includes notifications service', () => {
    const state = makePi5State()
    const compose = generateCompose(state, registry)

    expect(compose).toContain('jarvis-notifications:')
  })

  it('still includes core services', () => {
    const state = makePi5State()
    const compose = generateCompose(state, registry)

    expect(compose).toContain('jarvis-config-service:')
    expect(compose).toContain('jarvis-auth:')
    expect(compose).toContain('jarvis-logs:')
    expect(compose).toContain('jarvis-command-center:')
  })

  describe('macOS with remote LLM', () => {
    it('excludes GPU services from compose on darwin', () => {
      const state: WizardState = {
        ...makePi5State(),
        platform: 'darwin',
        enabledModules: ['jarvis-llm-proxy-api', 'jarvis-tts'],
      }
      const services = getComposeServices(state, registry)
      const ids = services.map((s) => s.id)
      // gpu=true + darwin = excluded (runs natively on macOS)
      expect(ids).not.toContain('jarvis-llm-proxy-api')
      // non-GPU services still included
      expect(ids).toContain('jarvis-tts')
    })
  })
})
