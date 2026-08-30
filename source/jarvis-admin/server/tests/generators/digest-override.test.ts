import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateCompose, type ImageDigestMap } from '../../src/services/generators/compose-generator.js'
import { parseRegistry } from '../../src/services/generators/service-registry.js'
import type { ServiceRegistry } from '../../src/types/service-registry.js'
import type { WizardState } from '../../src/types/wizard.js'

function loadRegistry(): ServiceRegistry {
  const raw = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../src/data/service-registry.json'), 'utf-8'),
  )
  return parseRegistry(raw)
}

function makeState(overrides: Partial<WizardState> = {}): WizardState {
  return {
    currentStep: 0,
    totalSteps: 7,
    enabledModules: [],
    portOverrides: {},
    infraPortOverrides: {},
    secrets: {},
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

const FRESH = 'sha256:' + 'a'.repeat(64)

describe('generateCompose digest override (runtime pin refresh)', () => {
  const registry = loadRegistry()

  it('pins a first-party image to a provided fresh digest (override wins over bundled)', () => {
    const digests: ImageDigestMap = { 'jarvis-admin': { latest: FRESH } }
    const output = generateCompose(makeState({ enabledModules: ['jarvis-admin'], pinImages: true }), registry, digests)
    expect(output).toContain(`ghcr.io/alexberardi/jarvis-admin@${FRESH}`)
  })

  it('falls back to the bundled digest map when no override is given', () => {
    const output = generateCompose(makeState({ enabledModules: ['jarvis-admin'], pinImages: true }), registry)
    expect(output).toMatch(/ghcr\.io\/alexberardi\/jarvis-admin@sha256:[0-9a-f]{64}/)
    expect(output).not.toContain(FRESH)
  })
})
