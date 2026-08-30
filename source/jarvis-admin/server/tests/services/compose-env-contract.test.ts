import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildUpgradedComposeFiles } from '../../src/services/upgrade/compose-upgrader.js'
import { reconstructWizardState } from '../../src/services/upgrade/state-reconstructor.js'
import { parseRegistry } from '../../src/services/generators/service-registry.js'

/**
 * COMPOSE ↔ ENV CONTRACT (the blank-secret outage class).
 *
 * Twice in one week (2026-07-04 inference 503s, 2026-07-06 MQTT rc=5) prod
 * broke because a generated compose referenced `${VAR}` values the applied
 * .env did not define — services came up with empty secrets. These tests
 * make that impossible at generation time: the compose and env are generated
 * AS A SET, and every substitution the compose performs must resolve.
 */

function loadRegistry() {
  return parseRegistry(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../src/data/service-registry.json'), 'utf-8')),
  )
}

// A maximal install: every recommended+optional module, GPU backends, relay.
function maximalEnv(): Record<string, string> {
  const FAKE = 'x'.repeat(64)
  return {
    POSTGRES_PASSWORD: FAKE, REDIS_PASSWORD: FAKE, AUTH_SECRET_KEY: FAKE,
    JARVIS_CONFIG_ADMIN_TOKEN: FAKE, JARVIS_AUTH_ADMIN_TOKEN: FAKE,
    ADMIN_API_KEY: FAKE, GRAFANA_ADMIN_PASSWORD: FAKE,
    MODEL_SERVICE_TOKEN: FAKE, MQTT_PASSWORD: FAKE,
    DB_USER: 'jarvis',
    CONFIG_SERVICE_PORT: '7700', AUTH_PORT: '7701', LOG_SERVER_PORT: '7702',
    COMMAND_CENTER_PORT: '7703', LLM_PROXY_API_PORT: '7704',
    WHISPER_API_PORT: '7706', TTS_PORT: '7707', SETTINGS_SERVER_PORT: '7708',
    ADMIN_PORT: '7711', NOTIFICATIONS_PORT: '7712', WEB_PORT: '7722',
    JARVIS_IMAGE_TAG: 'latest', HOST_OS: 'linux',
    WHISPER_BACKEND: 'cuda', TTS_BACKEND: 'cuda', TTS_GPU_DEVICE: '1',
    JARVIS_RELAY_URL: 'https://relay.jarvisautomation.io',
    JARVIS_RELAY_HOUSEHOLD_JWT: 'jwt-value',
    MQTT_ALLOW_ANON: 'true',
  }
}

function envKeys(env: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of env.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i === -1) continue
    map.set(t.slice(0, i), t.slice(i + 1))
  }
  return map
}

// Vars legitimately resolved by the runtime environment, not the .env file.
const RUNTIME_PROVIDED = new Set(['HOME'])

// Secret-shaped keys where an EMPTY ${VAR:-} fallback is correct: genuinely
// optional integrations, not auth material. Anything added here needs a reason.
const OPTIONAL_SECRETS = new Set([
  'HUGGINGFACE_HUB_TOKEN', // only needed for gated HF model downloads
])

// The contract must hold for the FULL linux compose (llm-proxy included).
// reconstructWizardState detects the host platform from process.env.HOST_OS;
// without forcing it, a darwin dev machine silently tests a smaller compose
// than CI does (that split shipped a green-local/red-CI test on 2026-07-07).
let savedHostOs: string | undefined
beforeAll(() => {
  savedHostOs = process.env.HOST_OS
  process.env.HOST_OS = 'linux'
})
afterAll(() => {
  if (savedHostOs === undefined) delete process.env.HOST_OS
  else process.env.HOST_OS = savedHostOs
})

function generate(existingEnv: Record<string, string>) {
  const registry = loadRegistry()
  // buildUpgradedComposeFiles reconstructs state internally (platform via
  // HOST_OS, forced to linux above) — exactly the reconcile code path.
  return buildUpgradedComposeFiles(existingEnv, registry, undefined, '/home/user/.jarvis/compose')
}

describe('compose ↔ env contract', () => {
  let compose: string
  let defined: Map<string, string>
  beforeAll(() => {
    const out = generate(maximalEnv())
    compose = out.compose
    defined = envKeys(out.env)
  })

  it('every ${VAR} without a default that the compose references is defined NON-EMPTY in the generated .env', () => {
    // ${VAR} (bare) must resolve; ${VAR:-default} is self-protecting.
    const bare = new Set<string>()
    for (const m of compose.matchAll(/\$\{([A-Z0-9_]+)\}/g)) bare.add(m[1])

    const missing: string[] = []
    for (const v of bare) {
      if (RUNTIME_PROVIDED.has(v)) continue
      const val = defined.get(v)
      if (!val) missing.push(v)
    }
    expect(missing, `compose references these vars but the generated .env leaves them undefined/empty: ${missing.join(', ')}`).toEqual([])
  })

  it('no service ever receives a literally-empty secret from a ${VAR:-} fallback for known secret keys', () => {
    // A `${SECRET:-}` (empty default) on a secret key silently disables auth.
    const emptyDefaultSecrets = [...new Set(
      [...compose.matchAll(/\$\{([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY)[A-Z0-9_]*):-\}/g)].map((m) => m[1]),
    )]
      // App-to-app credentials are intentionally empty until service
      // registration fills them post-install.
      .filter((v) => !v.startsWith('JARVIS_APP_ID_') && !v.startsWith('JARVIS_APP_KEY_'))
      .filter((v) => !OPTIONAL_SECRETS.has(v))
    expect(emptyDefaultSecrets).toEqual([])
  })
})

describe('regeneration idempotency', () => {
  it('regenerating from a generated .env produces an identical compose (no drift, no churn)', () => {
    const first = generate(maximalEnv())
    const second = generate(Object.fromEntries(envKeys(first.env)))
    expect(second.compose).toEqual(first.compose)
  })

  it('critical state round-trips through the generated .env', () => {
    const registry = loadRegistry()
    const first = generate(maximalEnv())
    const state = reconstructWizardState(Object.fromEntries(envKeys(first.env)), registry)
    expect(state.whisperBackend).toBe('cuda')
    expect(state.ttsBackend).toBe('cuda')
    expect(state.pinImages).toBe(false)
    expect(state.releaseTrack).toBe('stable')
    expect(state.relayEnabled).toBe(true)
    expect(state.enabledModules).toContain('jarvis-whisper-api')
    expect(state.enabledModules).toContain('jarvis-tts')
    expect(state.enabledModules).toContain('jarvis-llm-proxy-api')
  })
})
