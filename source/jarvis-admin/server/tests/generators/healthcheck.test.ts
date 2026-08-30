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

describe('compose healthchecks', () => {
  const registry = loadRegistry()

  // Node-based first-party images have no python. The default python-urllib
  // healthcheck fails with `exec: "python": executable file not found` and pins
  // the container "unhealthy" forever (found live on the prod admin). These
  // must get NO compose healthcheck so their Dockerfile's own wget HEALTHCHECK
  // applies instead.
  for (const nodeService of ['jarvis-admin', 'jarvis-web']) {
    it(`emits no python healthcheck for the Node service ${nodeService}`, () => {
      const output = generateCompose(
        makeState({ enabledModules: [nodeService] }),
        registry,
      )
      const block = serviceBlock(output, nodeService)
      expect(block).not.toBe('')
      expect(block).not.toContain('"python"')
      expect(block).not.toContain('healthcheck:')
    })
  }

  it('still emits the python healthcheck for python-based services', () => {
    // jarvis-auth is core (always present) and is a python image — it must keep
    // its healthcheck so we haven't over-broadened the skip.
    const output = generateCompose(makeState(), registry)
    const block = serviceBlock(output, 'jarvis-auth')
    expect(block).toContain('healthcheck:')
    expect(block).toContain('"python"')
  })
})
