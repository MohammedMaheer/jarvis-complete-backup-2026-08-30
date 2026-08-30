import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateCompose } from '../../src/services/generators/compose-generator.js'
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

// Slice the YAML block for one service: from `  <id>:` down to the next line at
// the same-or-shallower indent that ends in `:` (the next service or top-level
// section). Indent-based so it survives generator reordering.
function serviceBlock(compose: string, id: string): string {
  const lines = compose.split('\n')
  const start = lines.findIndex((l) => l.trim() === `${id}:`)
  if (start === -1) return ''
  const indent = lines[start].length - lines[start].trimStart().length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '') continue
    const ind = l.length - l.trimStart().length
    if (ind <= indent && l.trim().endsWith(':')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

describe('jarvis-admin → command-center admin key wiring', () => {
  const registry = loadRegistry()

  it('injects COMMAND_CENTER_ADMIN_KEY (from the shared ADMIN_API_KEY secret) into jarvis-admin', () => {
    const output = generateCompose(makeState({ enabledModules: ['jarvis-admin'] }), registry)
    const block = serviceBlock(output, 'jarvis-admin')
    expect(block).not.toBe('')
    expect(block).toContain('COMMAND_CENTER_ADMIN_KEY: ${ADMIN_API_KEY}')
  })

  it('scopes the key to the jarvis-admin block only — never leaked into other services', () => {
    // jarvis-admin is core, so it's always present (even with no optional
    // modules) and always gets the key; the guarantee that matters is that
    // COMMAND_CENTER_ADMIN_KEY appears in NO other service's block.
    const output = generateCompose(makeState({ enabledModules: [] }), registry)
    expect(serviceBlock(output, 'jarvis-admin')).toContain('COMMAND_CENTER_ADMIN_KEY')
    for (const id of ['jarvis-command-center', 'jarvis-auth', 'jarvis-config-service', 'jarvis-logs']) {
      expect(serviceBlock(output, id)).not.toContain('COMMAND_CENTER_ADMIN_KEY')
    }
  })
})
