import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateEnv } from '../../src/services/generators/env-generator.js'
import { generateCompose } from '../../src/services/generators/compose-generator.js'
import { parseRegistry } from '../../src/services/generators/service-registry.js'
import { generateAllSecrets, SECRET_KEYS } from '../../src/services/generators/secret-generator.js'
import type { ServiceRegistry } from '../../src/types/service-registry.js'
import type { WizardState } from '../../src/types/wizard.js'

function loadRegistry(): ServiceRegistry {
  return parseRegistry(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../src/data/service-registry.json'), 'utf-8')),
  )
}

function makeState(overrides: Partial<WizardState> = {}): WizardState {
  return {
    currentStep: 0,
    totalSteps: 7,
    enabledModules: ['jarvis-whisper-api', 'jarvis-tts'],
    portOverrides: {},
    infraPortOverrides: {},
    secrets: generateAllSecrets(),
    dbUser: 'jarvis',
    whisperModel: 'base.en',
    whisperModelPath: '/whisper-models/ggml-base.en.bin',
    llmInterface: 'JarvisToolModel',
    deploymentMode: 'local',
    deploymentTarget: 'standard',
    remoteLlmUrl: '',
    remoteWhisperUrl: '',
    platform: 'linux',
    hardware: null,
    releaseTrack: 'stable' as const,
    relayEnabled: false,
    relayUrl: '',
    nativeServices: [],
    ...overrides,
  }
}

const registry = loadRegistry()

describe('production hardening (JARVIS_ENV + no empty secrets)', () => {
  it('compose-generator emits JARVIS_ENV=production for services', () => {
    const compose = generateCompose(makeState(), registry)
    expect(compose).toContain('JARVIS_ENV: "production"')
  })

  it('env-generator never writes an empty secret (would break boot under production)', () => {
    // Drop a secret to simulate a reconstructed/gappy install.
    const secrets = generateAllSecrets() as Record<string, string>
    delete secrets.AUTH_SECRET_KEY
    const env = generateEnv(makeState({ secrets }), registry)

    const line = env.split('\n').find((l) => l.startsWith('AUTH_SECRET_KEY='))
    expect(line).toBeDefined()
    const value = line!.split('=')[1] ?? ''
    expect(value.length).toBeGreaterThanOrEqual(32)
    expect(env).not.toMatch(/^AUTH_SECRET_KEY=$/m)
  })

  it('env-generator keeps a provided secret verbatim', () => {
    const secrets = generateAllSecrets() as Record<string, string>
    secrets.AUTH_SECRET_KEY = 'z'.repeat(64)
    const env = generateEnv(makeState({ secrets }), registry)
    expect(env).toContain(`AUTH_SECRET_KEY=${'z'.repeat(64)}`)
  })

  it('every SECRET_KEY is present and non-empty', () => {
    const env = generateEnv(makeState({ secrets: {} }), registry)
    for (const key of SECRET_KEYS) {
      expect(env).toMatch(new RegExp(`^${key}=.+$`, 'm'))
    }
  })
})
