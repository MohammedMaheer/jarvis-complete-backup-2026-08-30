import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateEnv } from '../../src/services/generators/env-generator.js'
import { parseRegistry } from '../../src/services/generators/service-registry.js'
import { generateAllSecrets, SECRET_KEYS } from '../../src/services/generators/secret-generator.js'
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

describe('env-generator', () => {
  const registry = loadRegistry()

  it('includes all secret keys', () => {
    const state = makeState()
    const output = generateEnv(state, registry)
    for (const key of SECRET_KEYS) {
      expect(output).toContain(`${key}=`)
    }
  })

  it('includes DB_USER', () => {
    const state = makeState({ dbUser: 'testuser' })
    const output = generateEnv(state, registry)
    expect(output).toContain('DB_USER=testuser')
  })

  it('includes service port variables', () => {
    const state = makeState()
    const output = generateEnv(state, registry)
    expect(output).toContain('CONFIG_SERVICE_PORT=7700')
    expect(output).toContain('AUTH_PORT=7701')
    expect(output).toContain('LOGS_PORT=7702')
    expect(output).toContain('COMMAND_CENTER_PORT=7703')
  })

  it('emits ADMIN_PORT on the backend port 7711, not the registry nominal 7710', () => {
    // admin's containerized backend (SPA + API + /health) serves on 7711; 7710 is
    // only its local redirect target. ADMIN_PORT must match the compose generator
    // so the published host port lands on 7711 (the install-e2e harness probes
    // :7711/health).
    const state = makeState({ enabledModules: ['jarvis-admin'] })
    const output = generateEnv(state, registry)
    expect(output).toContain('ADMIN_PORT=7711')
    expect(output).not.toContain('ADMIN_PORT=7710')
  })

  it('applies port overrides', () => {
    const state = makeState({
      portOverrides: { 'jarvis-auth': 8888 },
    })
    const output = generateEnv(state, registry)
    expect(output).toContain('AUTH_PORT=8888')
  })

  it('includes infrastructure ports', () => {
    const state = makeState()
    const output = generateEnv(state, registry)
    expect(output).toContain('POSTGRES_PORT=5432')
    expect(output).toContain('REDIS_PORT=6379')
  })

  it('includes app-to-app auth placeholders', () => {
    const state = makeState()
    const output = generateEnv(state, registry)
    expect(output).toContain('JARVIS_APP_ID_AUTH=')
    expect(output).toContain('JARVIS_APP_KEY_AUTH=')
  })

  it('locks the MQTT broker for fresh installs (P0.4 — allow_anonymous=false)', () => {
    // A fresh node fetches broker creds over authenticated HTTP before it ever
    // opens an MQTT connection, so there is no anonymous client to strand —
    // locking from the first boot closes the anonymous-broker RCE window. The
    // transition window (true) is reserved for in-place upgrades only.
    const state = makeState()
    const output = generateEnv(state, registry)
    expect(output).toContain('MQTT_ALLOW_ANON=false')
  })

  describe('remote-llm mode', () => {
    it('includes remote URLs', () => {
      const state = makeState({
        deploymentMode: 'remote-llm',
        remoteLlmUrl: 'http://192.168.1.100:7704',
        remoteWhisperUrl: 'http://192.168.1.100:7706',
      })
      const output = generateEnv(state, registry)
      expect(output).toContain('JARVIS_LLM_PROXY_URL=http://192.168.1.100:7704')
      expect(output).toContain('JARVIS_WHISPER_URL=http://192.168.1.100:7706')
    })

    it('omits remote URLs in local mode', () => {
      const state = makeState({ deploymentMode: 'local' })
      const output = generateEnv(state, registry)
      expect(output).not.toContain('JARVIS_LLM_PROXY_URL=')
      expect(output).not.toContain('JARVIS_WHISPER_URL=')
    })
  })

  describe('MODELS_DIR (admin-in-docker)', () => {
    it('writes absolute MODELS_DIR when state.hostComposePath is set', () => {
      const state = makeState({ hostComposePath: '/home/jarvis/.jarvis/compose' })
      const output = generateEnv(state, registry)
      expect(output).toContain('MODELS_DIR=/home/jarvis/.jarvis/compose/.models')
    })

    it('strips trailing slash from hostComposePath', () => {
      const state = makeState({ hostComposePath: '/var/lib/jarvis/' })
      const output = generateEnv(state, registry)
      expect(output).toContain('MODELS_DIR=/var/lib/jarvis/.models')
    })

    it('omits MODELS_DIR when hostComposePath is unset (native install)', () => {
      const state = makeState({ hostComposePath: undefined })
      const output = generateEnv(state, registry)
      expect(output).not.toContain('MODELS_DIR=')
    })
  })

  describe('WHISPER_MODELS_DIR (admin-in-docker)', () => {
    it('writes absolute WHISPER_MODELS_DIR when state.hostComposePath is set', () => {
      const state = makeState({ hostComposePath: '/home/jarvis/.jarvis/compose' })
      const output = generateEnv(state, registry)
      expect(output).toContain('WHISPER_MODELS_DIR=/home/jarvis/.jarvis/compose/whisper-models')
    })

    it('strips trailing slash from hostComposePath for WHISPER_MODELS_DIR', () => {
      const state = makeState({ hostComposePath: '/var/lib/jarvis/' })
      const output = generateEnv(state, registry)
      expect(output).toContain('WHISPER_MODELS_DIR=/var/lib/jarvis/whisper-models')
    })

    it('omits WHISPER_MODELS_DIR when hostComposePath is unset (native install)', () => {
      const state = makeState({ hostComposePath: undefined })
      const output = generateEnv(state, registry)
      expect(output).not.toContain('WHISPER_MODELS_DIR=')
    })
  })

  describe('INIT_DB_PATH and GO2RTC_CONFIG_PATH (admin-in-docker)', () => {
    it('writes absolute INIT_DB_PATH when state.hostComposePath is set', () => {
      const state = makeState({ hostComposePath: '/home/jarvis/.jarvis/compose' })
      const output = generateEnv(state, registry)
      expect(output).toContain('INIT_DB_PATH=/home/jarvis/.jarvis/compose/init-db.sh')
    })

    it('writes absolute GO2RTC_CONFIG_PATH when state.hostComposePath is set', () => {
      const state = makeState({ hostComposePath: '/home/jarvis/.jarvis/compose' })
      const output = generateEnv(state, registry)
      expect(output).toContain('GO2RTC_CONFIG_PATH=/home/jarvis/.jarvis/compose/go2rtc.yaml')
    })

    it('strips trailing slash from hostComposePath for both vars', () => {
      const state = makeState({ hostComposePath: '/var/lib/jarvis/' })
      const output = generateEnv(state, registry)
      expect(output).toContain('INIT_DB_PATH=/var/lib/jarvis/init-db.sh')
      expect(output).toContain('GO2RTC_CONFIG_PATH=/var/lib/jarvis/go2rtc.yaml')
    })

    it('omits both vars when hostComposePath is unset (native install)', () => {
      const state = makeState({ hostComposePath: undefined })
      const output = generateEnv(state, registry)
      expect(output).not.toContain('INIT_DB_PATH=')
      expect(output).not.toContain('GO2RTC_CONFIG_PATH=')
    })
  })

  describe('Jarvis Relay', () => {
    it('writes JARVIS_RELAY_URL with default when enabled and no custom URL', () => {
      const state = makeState({ relayEnabled: true, relayUrl: '' })
      const output = generateEnv(state, registry)
      expect(output).toContain('JARVIS_RELAY_URL=https://relay.jarvisautomation.io')
    })

    it('writes JARVIS_RELAY_URL with custom value when provided', () => {
      const state = makeState({ relayEnabled: true, relayUrl: 'https://relay.example.com' })
      const output = generateEnv(state, registry)
      expect(output).toContain('JARVIS_RELAY_URL=https://relay.example.com')
    })

    it('omits JARVIS_RELAY_URL entirely when relayEnabled is false', () => {
      const state = makeState({ relayEnabled: false, relayUrl: 'https://relay.example.com' })
      const output = generateEnv(state, registry)
      expect(output).not.toContain('JARVIS_RELAY_URL=')
    })

    it('emits empty JARVIS_RELAY_HOUSEHOLD_JWT placeholder when enabled and no value', () => {
      const state = makeState({ relayEnabled: true, relayUrl: '' })
      const output = generateEnv(state, registry)
      expect(output).toContain('JARVIS_RELAY_HOUSEHOLD_JWT=')
    })

    it('emits JARVIS_RELAY_HOUSEHOLD_JWT with provided value', () => {
      const state = makeState({
        relayEnabled: true,
        relayUrl: '',
        relayHouseholdJwt: 'eyJhbGciOiJIUzI1NiJ9.testtoken',
      })
      const output = generateEnv(state, registry)
      expect(output).toContain('JARVIS_RELAY_HOUSEHOLD_JWT=eyJhbGciOiJIUzI1NiJ9.testtoken')
    })

    it('omits JARVIS_RELAY_HOUSEHOLD_JWT entirely when relayEnabled is false', () => {
      const state = makeState({
        relayEnabled: false,
        relayHouseholdJwt: 'eyJhbGciOiJIUzI1NiJ9.testtoken',
      })
      const output = generateEnv(state, registry)
      expect(output).not.toContain('JARVIS_RELAY_HOUSEHOLD_JWT')
    })
  })

  describe('Release Track', () => {
    it('includes JARVIS_IMAGE_TAG=latest for stable track', () => {
      const state = makeState({ releaseTrack: 'stable' })
      const output = generateEnv(state, registry)
      expect(output).toContain('JARVIS_IMAGE_TAG=latest')
    })

    it('includes JARVIS_IMAGE_TAG=dev for dev track', () => {
      const state = makeState({ releaseTrack: 'dev' })
      const output = generateEnv(state, registry)
      expect(output).toContain('JARVIS_IMAGE_TAG=dev')
    })

    it('includes release track section comment', () => {
      const state = makeState()
      const output = generateEnv(state, registry)
      expect(output).toContain('# --- Release Track ---')
    })
  })

  describe('Whisper backend', () => {
    // The backend selection exists nowhere else in the install: the compose
    // pins the image by digest, so without this env key a reconcile
    // reconstructs whisperBackend as undefined -> cpu and silently swaps a
    // GPU whisper for the CPU image (prod, 2026-07-04: STT 90ms -> 16s).
    it('persists the selected backend', () => {
      const state = makeState({ whisperBackend: 'cuda' })
      const output = generateEnv(state, registry)
      expect(output).toContain('WHISPER_BACKEND=cuda')
    })

    it('defaults to cpu when unset', () => {
      const state = makeState()
      const output = generateEnv(state, registry)
      expect(output).toContain('WHISPER_BACKEND=cpu')
    })
  })

  describe('Whisper model', () => {
    // Like the backend, the model path lives only in the compose environment
    // block (and only when non-default), so without this key a reconcile
    // reconstructs base.en and silently downgrades a bigger model.
    it('persists the selected model path', () => {
      const state = makeState({ whisperModelPath: '/whisper-models/ggml-small.en.bin' })
      const output = generateEnv(state, registry)
      expect(output).toContain('WHISPER_MODEL=/whisper-models/ggml-small.en.bin')
    })

    it('defaults to base.en when unset', () => {
      const state = makeState()
      const output = generateEnv(state, registry)
      expect(output).toContain('WHISPER_MODEL=/whisper-models/ggml-base.en.bin')
    })
  })

  describe('TTS backend', () => {
    it('persists the selected backend and a default GPU index', () => {
      const state = makeState({ ttsBackend: 'cuda' })
      const output = generateEnv(state, registry)
      expect(output).toContain('TTS_BACKEND=cuda')
      // Surfaced so operators can re-pin (e.g. TTS_GPU_DEVICE=1 when GPU0
      // is full of LLM+whisper); compose falls back to 0 if absent.
      expect(output).toContain('TTS_GPU_DEVICE=0')
    })

    it('defaults to cpu with no GPU index line', () => {
      const state = makeState()
      const output = generateEnv(state, registry)
      expect(output).toContain('TTS_BACKEND=cpu')
      expect(output).not.toContain('TTS_GPU_DEVICE')
    })
  })

  describe('Host platform', () => {
    it('writes HOST_OS=darwin for Mac installs', () => {
      const state = makeState({ platform: 'darwin' })
      const output = generateEnv(state, registry)
      expect(output).toContain('HOST_OS=darwin')
    })

    it('writes HOST_OS=linux for Linux installs', () => {
      const state = makeState({ platform: 'linux' })
      const output = generateEnv(state, registry)
      expect(output).toContain('HOST_OS=linux')
    })
  })

  describe('Native services (macOS)', () => {
    it('writes JARVIS_NATIVE_SERVICES as a comma-separated list when populated', () => {
      const state = makeState({
        platform: 'darwin',
        nativeServices: ['jarvis-llm-proxy-api', 'jarvis-whisper-api', 'jarvis-tts'],
      })
      const output = generateEnv(state, registry)
      expect(output).toContain('JARVIS_NATIVE_SERVICES=jarvis-llm-proxy-api,jarvis-whisper-api,jarvis-tts')
    })

    it('omits the section entirely when no native services are selected', () => {
      const state = makeState({ nativeServices: [] })
      const output = generateEnv(state, registry)
      expect(output).not.toContain('JARVIS_NATIVE_SERVICES')
      expect(output).not.toContain('# --- Native Services')
    })
  })
})

describe('Phone gateway (jarvis-phone-gateway)', () => {
  const registry = loadRegistry()

  it('writes port + empty Twilio placeholders when enabled', () => {
    const output = generateEnv(
      makeState({ enabledModules: ['jarvis-phone-gateway'] }),
      registry,
    )
    expect(output).toContain('PHONE_GATEWAY_PORT=7713')
    expect(output).toContain('# --- Phone Gateway')
    expect(output).toContain('TWILIO_ACCOUNT_SID=')
    expect(output).toContain('TWILIO_AUTH_TOKEN=')
    expect(output).toContain('TWILIO_FROM_NUMBER=')
    expect(output).toContain('PHONE_GATEWAY_PUBLIC_WSS_URL=')
    // App-to-app placeholder pair for the gateway
    expect(output).toContain('JARVIS_APP_ID_PHONE_GATEWAY=')
  })

  it('writes nothing phone-related when not enabled', () => {
    const output = generateEnv(makeState({ enabledModules: [] }), registry)
    expect(output).not.toContain('PHONE_GATEWAY_PORT')
    expect(output).not.toContain('TWILIO_ACCOUNT_SID')
  })

  it('emits SERVING_TYPE (default llama-cpp) so a regen reconstructs the live-model serving', () => {
    expect(generateEnv(makeState(), registry)).toMatch(/^SERVING_TYPE=llama-cpp$/m)
  })

  it('emits the chosen serving type when llama-server is selected', () => {
    expect(generateEnv(makeState({ servingType: 'llama-server' }), registry)).toMatch(/^SERVING_TYPE=llama-server$/m)
  })
})
