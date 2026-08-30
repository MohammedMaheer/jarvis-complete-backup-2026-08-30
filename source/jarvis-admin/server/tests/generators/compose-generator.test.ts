import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateCompose, getAllEnabledServices, getComposeServices, getComposeWorkerIds, pinnedOrTaggedImage } from '../../src/services/generators/compose-generator.js'

// Expected image line for a first-party service at (track, variant suffix).
// Computed through the same helper the generator uses, so these assertions
// verify correct VARIANT selection and survive a digest-map refresh (they read
// whatever the committed map holds — a digest when pinned, the tag when not).
const WHISPER_IMG = 'ghcr.io/alexberardi/jarvis-whisper-api'
function imgLine(base: string, suffix: string, track: 'latest' | 'dev' = 'latest'): string {
  return 'image: ' + pinnedOrTaggedImage(base, track, suffix)
}
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
    enabledModules: ['jarvis-whisper-api', 'jarvis-tts'],
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

describe('compose-generator', () => {
  const registry = loadRegistry()

  it('generates valid compose YAML structure', () => {
    const state = makeState()
    const output = generateCompose(state, registry)
    expect(output).toContain('services:')
    expect(output).toContain('networks:')
    expect(output).toContain('volumes:')
  })

  it('includes core services always', () => {
    const state = makeState({ enabledModules: [] })
    const output = generateCompose(state, registry)
    expect(output).toContain('jarvis-config-service:')
    expect(output).toContain('jarvis-auth:')
    expect(output).toContain('jarvis-logs:')
    expect(output).toContain('jarvis-command-center:')
  })

  it('includes enabled recommended services', () => {
    const state = makeState({ enabledModules: ['jarvis-tts'] })
    const output = generateCompose(state, registry)
    expect(output).toContain('jarvis-tts:')
  })

  it('excludes non-enabled optional services', () => {
    const state = makeState({ enabledModules: [] })
    const output = generateCompose(state, registry)
    expect(output).not.toContain('jarvis-web:')
  })

  it('includes extra_hosts for host.docker.internal', () => {
    const state = makeState()
    const output = generateCompose(state, registry)
    expect(output).toContain('host.docker.internal:host-gateway')
  })

  it('includes app-to-app auth placeholders', () => {
    const state = makeState()
    const output = generateCompose(state, registry)
    expect(output).toContain('JARVIS_APP_ID')
    expect(output).toContain('JARVIS_APP_KEY')
  })

  describe('macOS GPU service exclusion', () => {
    it('excludes llm-proxy from compose on darwin', () => {
      const state = makeState({
        platform: 'darwin',
        enabledModules: ['jarvis-llm-proxy-api', 'jarvis-tts'],
      })
      const services = getComposeServices(state, registry)
      const ids = services.map((s) => s.id)
      expect(ids).not.toContain('jarvis-llm-proxy-api')
    })

    it('includes llm-proxy in compose on linux', () => {
      const state = makeState({
        platform: 'linux',
        enabledModules: ['jarvis-llm-proxy-api', 'jarvis-tts'],
      })
      const services = getComposeServices(state, registry)
      const ids = services.map((s) => s.id)
      expect(ids).toContain('jarvis-llm-proxy-api')
    })

    it('includes llm-proxy in all enabled list regardless of platform', () => {
      const state = makeState({
        platform: 'darwin',
        enabledModules: ['jarvis-llm-proxy-api'],
      })
      const all = getAllEnabledServices(state, registry)
      const ids = all.map((s) => s.id)
      expect(ids).toContain('jarvis-llm-proxy-api')
    })

    it('excludes jarvis-admin from the compose on darwin (runs native, never containerized)', () => {
      // A containerized admin on Docker Desktop resolves bind paths against
      // its /host/compose mount, which Docker Desktop refuses to share —
      // postgres then can't start and the DB services crash-loop (2026-07-10).
      const services = getComposeServices(makeState({ platform: 'darwin' }), registry)
      expect(services.map((s) => s.id)).not.toContain('jarvis-admin')
    })

    it('includes jarvis-admin in the compose on linux (containerized there)', () => {
      const services = getComposeServices(makeState({ platform: 'linux' }), registry)
      expect(services.map((s) => s.id)).toContain('jarvis-admin')
    })

    it('keeps jarvis-admin in the enabled (core) list on darwin — it is still installed, just native', () => {
      const all = getAllEnabledServices(makeState({ platform: 'darwin' }), registry)
      expect(all.map((s) => s.id)).toContain('jarvis-admin')
    })
  })

  describe('GPU service config', () => {
    it('adds nvidia deploy config for llm-proxy on linux', () => {
      const state = makeState({
        platform: 'linux',
        enabledModules: ['jarvis-llm-proxy-api', 'jarvis-tts'],
        hardware: {
          platform: 'linux',
          arch: 'x86_64',
          totalMemoryGb: 32,
          gpuName: 'NVIDIA RTX 3090',
          gpuVramMb: 24576,
          gpuType: 'nvidia',
          recommendedBackends: ['gguf', 'vllm'],
          recommendedBackend: 'gguf',
        },
      })
      const output = generateCompose(state, registry)
      expect(output).toContain('driver: nvidia')
      expect(output).toContain('capabilities: [gpu]')
      expect(output).toContain('ipc: host')
      expect(output).toContain('shm_size: "8gb"')
      expect(output).toContain('.models')
      // llm-proxy (and its worker) KEEP count: all — their in-process GPU path
      // is unused when the llama sidecars serve inference, but other
      // deployments rely on it. Only whisper + the sidecars are device-pinned.
      expect(output).toContain('count: all')
    })

    it('adds vulkan device passthrough for AMD GPU', () => {
      const state = makeState({
        platform: 'linux',
        enabledModules: ['jarvis-llm-proxy-api'],
        hardware: {
          platform: 'linux',
          arch: 'x86_64',
          totalMemoryGb: 32,
          gpuName: 'AMD RX 9070 XT',
          gpuVramMb: 16384,
          gpuType: 'amd',
          recommendedBackends: ['gguf'],
          recommendedBackend: 'gguf',
        },
      })
      const output = generateCompose(state, registry)
      expect(output).toContain('/dev/dri:/dev/dri')
      expect(output).toContain('/dev/kfd:/dev/kfd')
      expect(output).toContain('ipc: host')
      expect(output).not.toContain('driver: nvidia')
    })
  })

  // Guards the "a generated AMD/Vulkan install actually works" contract against a
  // known-good compose. Shaped so a CUDA profile can be added the same way.
  describe('AMD/Vulkan install profile', () => {
    function serviceBlock(output: string, id: string): string {
      const start = output.indexOf(`\n  ${id}:\n`)
      expect(start, `${id} missing from compose`).toBeGreaterThanOrEqual(0)
      const after = output.slice(start + `\n  ${id}:\n`.length)
      const next = after.match(/\n {2}[a-z][a-z0-9-]*:\n/)
      return next ? after.slice(0, next.index) : after
    }
    function amdState() {
      return makeState({
        platform: 'linux',
        enabledModules: ['jarvis-llm-proxy-api', 'jarvis-whisper-api'],
        hardware: {
          platform: 'linux',
          arch: 'x86_64',
          totalMemoryGb: 32,
          gpuName: 'AMD Radeon RX 9070',
          gpuVramMb: 16384,
          gpuType: 'amd',
          recommendedBackends: ['gguf'],
          recommendedBackend: 'gguf',
        },
      })
    }

    it('emits MODEL_SERVICE_TOKEN on the llm-proxy API AND worker (else inference 503s)', () => {
      const out = generateCompose(amdState(), registry)
      expect(serviceBlock(out, 'jarvis-llm-proxy-api')).toContain('MODEL_SERVICE_TOKEN: ${MODEL_SERVICE_TOKEN}')
      expect(serviceBlock(out, 'llm-proxy-worker')).toContain('MODEL_SERVICE_TOKEN: ${MODEL_SERVICE_TOKEN}')
    })

    it('emits JARVIS_FLASH_ATTN=false on the AMD llm-proxy API AND worker', () => {
      const out = generateCompose(amdState(), registry)
      expect(serviceBlock(out, 'jarvis-llm-proxy-api')).toContain('JARVIS_FLASH_ATTN: "false"')
      expect(serviceBlock(out, 'llm-proxy-worker')).toContain('JARVIS_FLASH_ATTN: "false"')
    })

    it('does NOT emit JARVIS_FLASH_ATTN for nvidia (its FA kernel is fine)', () => {
      const nv = makeState({
        platform: 'linux',
        enabledModules: ['jarvis-llm-proxy-api'],
        hardware: {
          platform: 'linux', arch: 'x86_64', totalMemoryGb: 32,
          gpuName: 'RTX 3090', gpuVramMb: 24576, gpuType: 'nvidia',
          recommendedBackends: ['gguf'], recommendedBackend: 'gguf',
        },
      })
      expect(generateCompose(nv, registry)).not.toContain('JARVIS_FLASH_ATTN')
    })

    it('gives llm-proxy the -vulkan image on AMD', () => {
      const llm = serviceBlock(generateCompose(amdState(), registry), 'jarvis-llm-proxy-api')
      expect(llm).toContain(imgLine('ghcr.io/alexberardi/jarvis-llm-proxy-api', '-vulkan'))
    })

    it('passes the discrete GPU through to llm-proxy (dri/kfd + render group + shm)', () => {
      const llm = serviceBlock(generateCompose(amdState(), registry), 'jarvis-llm-proxy-api')
      expect(llm).toContain('/dev/dri:/dev/dri')
      expect(llm).toContain('/dev/kfd:/dev/kfd')
      expect(llm).toContain('- render')
      expect(llm).toContain('shm_size')
    })

    it('does NOT hardcode a device index — the image auto-selects the discrete GPU', () => {
      const llm = serviceBlock(generateCompose(amdState(), registry), 'jarvis-llm-proxy-api')
      expect(llm).not.toContain('GGML_VK_VISIBLE_DEVICES')
      expect(llm).not.toContain('HIP_VISIBLE_DEVICES')
    })
  })

  describe('cpuFallback (whisper) GPU variant selection', () => {
    function whisperState(gpuType: 'nvidia' | 'amd' | 'amd-rocm' | 'none' | null, platform: 'linux' | 'darwin' = 'linux') {
      return makeState({
        platform,
        enabledModules: ['jarvis-whisper-api'],
        hardware: gpuType
          ? {
              platform,
              arch: 'x86_64',
              totalMemoryGb: 32,
              gpuName: 'test',
              gpuVramMb: 8192,
              gpuType,
              recommendedBackends: ['gguf'],
              recommendedBackend: 'gguf',
            }
          : null,
      })
    }

    // Whisper's variant is chosen EXPLICITLY via whisperBackend (default cpu),
    // independent of the auto-detected LLM gpuType.
    function whisperBackendState(whisperBackend: 'cpu' | 'cuda' | 'vulkan' | 'rocm') {
      return makeState({ platform: 'linux', whisperBackend, enabledModules: ['jarvis-whisper-api'] })
    }
    function whisperBlock(output: string): string {
      const block = output.slice(output.indexOf('jarvis-whisper-api:'))
      const end = block.search(/\n {2}[a-z][a-z0-9-]*:\n/)
      return end > 0 ? block.slice(0, end) : block
    }

    it('cpu (default): plain image, no GPU passthrough', () => {
      const w = whisperBlock(generateCompose(whisperBackendState('cpu'), registry))
      expect(w).toContain(imgLine(WHISPER_IMG, ''))
      expect(w).not.toContain('-vulkan')
      expect(w).not.toContain('-cuda')
      expect(w).not.toContain('/dev/dri')
      expect(w).not.toContain('driver: nvidia')
    })

    it('cuda: -cuda image + nvidia deploy block pinned to ONE gpu (WHISPER_GPU_DEVICE)', () => {
      // count: all let CUDA spread work across both cards — whisper is pinned
      // to GPU0 (with the bg sidecar), away from live voice on GPU1
      // (prod 2026-08-15 layer-split contention).
      const w = whisperBlock(generateCompose(whisperBackendState('cuda'), registry))
      expect(w).toContain(imgLine(WHISPER_IMG, '-cuda'))
      expect(w).toContain('driver: nvidia')
      expect(w).toContain("device_ids: ['${WHISPER_GPU_DEVICE:-0}']")
      expect(w).not.toContain('count: all')
    })

    it('vulkan: -vulkan image + /dev/dri + render group', () => {
      const w = whisperBlock(generateCompose(whisperBackendState('vulkan'), registry))
      expect(w).toContain(imgLine(WHISPER_IMG, '-vulkan'))
      expect(w).toContain('/dev/dri:/dev/dri')
      expect(w).toContain('- render')
    })

    it('rocm: -rocm image + /dev/dri + /dev/kfd', () => {
      const w = whisperBlock(generateCompose(whisperBackendState('rocm'), registry))
      expect(w).toContain(imgLine(WHISPER_IMG, '-rocm'))
      expect(w).toContain('/dev/dri:/dev/dri')
      expect(w).toContain('/dev/kfd:/dev/kfd')
    })

    it('is independent of the LLM gpuType (amd LLM + default cpu whisper -> plain whisper)', () => {
      // whisperState('amd') sets an AMD *LLM* host but leaves whisperBackend unset (-> cpu).
      const w = whisperBlock(generateCompose(whisperState('amd'), registry))
      expect(w).toContain(imgLine(WHISPER_IMG, ''))
      expect(w).not.toContain('-vulkan')
      expect(w).not.toContain('/dev/dri')
    })

    it('still emits whisper on macOS (cpuFallback overrides darwin GPU exclusion)', () => {
      const services = getComposeServices(whisperState(null, 'darwin'), registry)
      const ids = services.map((s) => s.id)
      expect(ids).toContain('jarvis-whisper-api')
    })

    it('does NOT mount the models volume on whisper (model is baked into image)', () => {
      const output = generateCompose(whisperState('nvidia'), registry)
      const block = output.slice(output.indexOf('jarvis-whisper-api:'))
      const blockEnd = block.search(/\n {2}[a-z][a-z0-9-]*:\n/)
      const whisperOnly = blockEnd > 0 ? block.slice(0, blockEnd) : block
      expect(whisperOnly).not.toContain('${MODELS_DIR:-./.models}:/app/.models')
    })

    it('mounts whisper-models via WHISPER_MODELS_DIR with relative fallback', () => {
      // Templated so env-generator's WHISPER_MODELS_DIR can swap in the
      // absolute host path under admin-in-docker without changing compose.
      const output = generateCompose(whisperState('nvidia'), registry)
      expect(output).toContain('${WHISPER_MODELS_DIR:-./whisper-models}:/whisper-models:ro')
    })

    it('still mounts models volume on llm-proxy (modelVolume: true)', () => {
      const state = makeState({
        platform: 'linux',
        enabledModules: ['jarvis-llm-proxy-api'],
        hardware: {
          platform: 'linux',
          arch: 'x86_64',
          totalMemoryGb: 32,
          gpuName: 'NVIDIA RTX 3090',
          gpuVramMb: 24576,
          gpuType: 'nvidia',
          recommendedBackends: ['gguf'],
          recommendedBackend: 'gguf',
        },
      })
      const output = generateCompose(state, registry)
      expect(output).toContain('${MODELS_DIR:-./.models}:/app/.models')
    })
  })

  describe('tts backend (explicit GPU toggle, no image variant)', () => {
    // TTS's stock image ships CUDA-capable torch, so unlike whisper the
    // toggle only controls device passthrough — never an image suffix.
    // The reservation pins ONE gpu (TTS_GPU_DEVICE, default 0): `count: all`
    // invites OOM on hosts whose GPU0 is already full of LLM + whisper
    // (prod 2026-07-05: kokoro warmup OOM'd next to a 20GB LLM).
    function ttsState(ttsBackend?: 'cpu' | 'cuda') {
      return makeState({ platform: 'linux', ttsBackend, enabledModules: ['jarvis-tts'] })
    }
    function ttsBlock(output: string): string {
      const block = output.slice(output.indexOf('jarvis-tts:'))
      const end = block.search(/\n {2}[a-z][a-z0-9-]*:\n/)
      return end > 0 ? block.slice(0, end) : block
    }

    it('cpu (default): no GPU passthrough', () => {
      const t = ttsBlock(generateCompose(ttsState(), registry))
      expect(t).not.toContain('driver: nvidia')
      expect(t).not.toContain('TTS_KOKORO_DEVICE')
    })

    it('cuda: single-GPU reservation via TTS_GPU_DEVICE + kokoro device env, no image suffix', () => {
      const t = ttsBlock(generateCompose(ttsState('cuda'), registry))
      expect(t).toContain("device_ids: ['${TTS_GPU_DEVICE:-0}']")
      expect(t).toContain('driver: nvidia')
      expect(t).not.toContain('count: all')
      // env_fallback for a fresh install whose settings DB has no
      // tts.kokoro_device row yet — DB value wins once set.
      expect(t).toContain('TTS_KOKORO_DEVICE: ${TTS_BACKEND:-cpu}')
      expect(t).not.toContain('jarvis-tts-cuda')
      expect(t).not.toContain('jarvis-tts:latest-cuda')
    })
  })

  describe('remote-llm mode', () => {
    it('adds remote LLM URL to command-center env', () => {
      const state = makeState({
        deploymentMode: 'remote-llm',
        remoteLlmUrl: 'http://192.168.1.100:7704',
        remoteWhisperUrl: 'http://192.168.1.100:7706',
      })
      const output = generateCompose(state, registry)
      expect(output).toContain('JARVIS_LLM_PROXY_URL: http://192.168.1.100:7704')
      expect(output).toContain('JARVIS_WHISPER_URL: http://192.168.1.100:7706')
    })
  })

  describe('Jarvis Relay', () => {
    it('emits JARVIS_RELAY_URL templated env on command-center when enabled', () => {
      const state = makeState({ relayEnabled: true, relayUrl: 'https://relay.example.com' })
      const output = generateCompose(state, registry)
      // Admin uses .env substitution — the value goes into .env via env-generator;
      // the compose just references the var. See env-generator.test.ts for the value test.
      expect(output).toContain('JARVIS_RELAY_URL: ${JARVIS_RELAY_URL:-}')
    })

    it('omits JARVIS_RELAY_URL on command-center when disabled', () => {
      const state = makeState({ relayEnabled: false })
      const output = generateCompose(state, registry)
      expect(output).not.toContain('JARVIS_RELAY_URL:')
    })

    it('emits RELAY_URL + RELAY_HOUSEHOLD_JWT on jarvis-notifications when enabled', () => {
      const state = makeState({
        relayEnabled: true,
        enabledModules: ['jarvis-notifications'],
      })
      const output = generateCompose(state, registry)
      // Sliced to the notifications block so we don't accidentally match the CC line.
      const notifIdx = output.indexOf('jarvis-notifications:')
      const nextSvcIdx = output.indexOf('\n  jarvis-', notifIdx + 1)
      const notifBlock = output.slice(notifIdx, nextSvcIdx === -1 ? undefined : nextSvcIdx)
      expect(notifBlock).toContain('RELAY_URL: ${JARVIS_RELAY_URL:-}')
      expect(notifBlock).toContain('RELAY_HOUSEHOLD_JWT: ${JARVIS_RELAY_HOUSEHOLD_JWT:-}')
    })

    it('omits RELAY_URL + RELAY_HOUSEHOLD_JWT on jarvis-notifications when disabled', () => {
      const state = makeState({
        relayEnabled: false,
        enabledModules: ['jarvis-notifications'],
      })
      const output = generateCompose(state, registry)
      const notifIdx = output.indexOf('jarvis-notifications:')
      const nextSvcIdx = output.indexOf('\n  jarvis-', notifIdx + 1)
      const notifBlock = output.slice(notifIdx, nextSvcIdx === -1 ? undefined : nextSvcIdx)
      expect(notifBlock).not.toContain('RELAY_URL:')
      expect(notifBlock).not.toContain('RELAY_HOUSEHOLD_JWT:')
    })
  })

  describe('native services on macOS', () => {
    it('excludes opted-in native services from compose on darwin', () => {
      const state = makeState({
        platform: 'darwin',
        enabledModules: ['jarvis-whisper-api', 'jarvis-tts', 'jarvis-llm-proxy-api', 'jarvis-notifications'],
        nativeServices: ['jarvis-whisper-api', 'jarvis-tts', 'jarvis-llm-proxy-api'],
      })
      const ids = getComposeServices(state, registry).map((s) => s.id)
      expect(ids).not.toContain('jarvis-whisper-api')
      expect(ids).not.toContain('jarvis-tts')
      expect(ids).not.toContain('jarvis-llm-proxy-api')
      // Non-native enabled service still in compose
      expect(ids).toContain('jarvis-notifications')
    })

    it('keeps services in compose on darwin when not opted in to native', () => {
      const state = makeState({
        platform: 'darwin',
        enabledModules: ['jarvis-whisper-api', 'jarvis-tts'],
        nativeServices: [],
      })
      const ids = getComposeServices(state, registry).map((s) => s.id)
      // Whisper has cpuFallback so it stays in compose (CPU image) when not opted-in
      expect(ids).toContain('jarvis-whisper-api')
      expect(ids).toContain('jarvis-tts')
    })

    it('ignores nativeServices on linux (Mac-only feature)', () => {
      const state = makeState({
        platform: 'linux',
        enabledModules: ['jarvis-whisper-api', 'jarvis-tts'],
        // Even if the field is populated, linux uses docker for everything
        nativeServices: ['jarvis-whisper-api', 'jarvis-tts'],
      })
      const ids = getComposeServices(state, registry).map((s) => s.id)
      expect(ids).toContain('jarvis-whisper-api')
      expect(ids).toContain('jarvis-tts')
    })
  })

  describe('postgres infrastructure', () => {
    it('includes postgres with healthcheck', () => {
      const state = makeState()
      const output = generateCompose(state, registry)
      expect(output).toContain('postgres:')
      expect(output).toContain('pg_isready')
      expect(output).toContain('init-db.sh')
    })

    it('mounts init-db.sh via INIT_DB_PATH with relative fallback', () => {
      // Templated so env-generator's INIT_DB_PATH can swap in the absolute
      // host path under admin-in-docker without changing compose.
      const output = generateCompose(makeState(), registry)
      expect(output).toContain('${INIT_DB_PATH:-./init-db.sh}:/docker-entrypoint-initdb.d/init-db.sh')
    })
  })

  describe('go2rtc', () => {
    it('mounts go2rtc.yaml via GO2RTC_CONFIG_PATH with relative fallback', () => {
      const state = makeState({ enabledModules: ['go2rtc'] })
      const output = generateCompose(state, registry)
      expect(output).toContain('${GO2RTC_CONFIG_PATH:-./go2rtc.yaml}:/config/go2rtc.yaml')
    })
  })

  describe('worker emission', () => {
    function nvidiaState() {
      return makeState({
        platform: 'linux',
        enabledModules: ['jarvis-llm-proxy-api'],
        hardware: {
          platform: 'linux',
          arch: 'x86_64',
          totalMemoryGb: 32,
          gpuName: 'NVIDIA RTX 3090',
          gpuVramMb: 24576,
          gpuType: 'nvidia',
          recommendedBackends: ['gguf', 'vllm'],
          recommendedBackend: 'gguf',
        },
      })
    }

    it('emits llm-proxy-worker as a sibling service', () => {
      const output = generateCompose(nvidiaState(), registry)
      expect(output).toContain('llm-proxy-worker:')
      expect(output).toContain('container_name: llm-proxy-worker')
    })

    it('worker uses the parent worker command and env override', () => {
      const output = generateCompose(nvidiaState(), registry)
      expect(output).toContain('command: python scripts/queue_worker.py')
      expect(output).toContain('LLM_PROXY_PROCESS_ROLE: worker')
      expect(output).toContain('MODEL_SERVICE_URL: http://jarvis-llm-proxy-api:7705')
    })

    it('worker depends_on parent service healthy', () => {
      const output = generateCompose(nvidiaState(), registry)
      const workerBlock = output.slice(output.indexOf('llm-proxy-worker:'))
      expect(workerBlock).toMatch(/depends_on:[\s\S]*jarvis-llm-proxy-api:\s*\n\s*condition: service_healthy/)
    })

    it('worker inherits parent GPU deploy block', () => {
      const output = generateCompose(nvidiaState(), registry)
      const workerBlock = output.slice(output.indexOf('llm-proxy-worker:'))
      // Worker section ends at the next top-level service or the networks/volumes block
      const workerEnd = workerBlock.search(/\n {2}[a-z][a-z0-9-]*:\n/)
      const workerOnly = workerEnd > 0 ? workerBlock.slice(0, workerEnd) : workerBlock
      expect(workerOnly).toContain('driver: nvidia')
      expect(workerOnly).toContain('capabilities: [gpu]')
      expect(workerOnly).toContain('ipc: host')
    })

    it('worker has no ports and no healthcheck', () => {
      const output = generateCompose(nvidiaState(), registry)
      const workerBlock = output.slice(output.indexOf('llm-proxy-worker:'))
      const workerEnd = workerBlock.search(/\n {2}[a-z][a-z0-9-]*:\n/)
      const workerOnly = workerEnd > 0 ? workerBlock.slice(0, workerEnd) : workerBlock
      expect(workerOnly).not.toContain('ports:')
      expect(workerOnly).not.toContain('healthcheck:')
    })

    it('worker is omitted when parent is excluded (darwin)', () => {
      const state = makeState({
        platform: 'darwin',
        enabledModules: ['jarvis-llm-proxy-api'],
      })
      const output = generateCompose(state, registry)
      expect(output).not.toContain('llm-proxy-worker:')
    })

    it('getComposeWorkerIds enumerates all workers across services', () => {
      const services = getAllEnabledServices(nvidiaState(), registry)
      const ids = getComposeWorkerIds(services)
      expect(ids).toContain('llm-proxy-worker')
    })

    it('getComposeWorkerIds returns empty when no parents have workers', () => {
      const services = getAllEnabledServices(
        makeState({ enabledModules: ['jarvis-tts'] }),
        registry,
      ).filter((s) => s.id !== 'jarvis-llm-proxy-api')
      const ids = getComposeWorkerIds(services)
      expect(ids).toEqual([])
    })
  })

  describe('service-level named volumes', () => {
    it('declares jarvis-tts HF cache volume at top level', () => {
      const state = makeState({ enabledModules: ['jarvis-tts'] })
      const output = generateCompose(state, registry)
      expect(output).toContain('- jarvis-tts-hf-cache:/app/models/hf_cache')
      // The named volume must also be declared in the top-level volumes section
      const volumesBlock = output.slice(output.lastIndexOf('volumes:'))
      expect(volumesBlock).toContain('jarvis-tts-hf-cache:')
    })

    it('does not declare bind-mount paths at top level', () => {
      // jarvis-mcp mounts /var/run/docker.sock — that's a bind mount and should
      // not appear as a top-level volume declaration.
      const state = makeState({ enabledModules: ['jarvis-mcp'] })
      const output = generateCompose(state, registry)
      const volumesBlock = output.slice(output.lastIndexOf('volumes:'))
      expect(volumesBlock).not.toContain('/var/run/docker.sock:')
    })

    it('llm-proxy keeps NVIDIA GPU config even when hardware is null (reconcile case)', () => {
      // Regression for v0.1.33: state-reconstructor returned hardware: null,
      // pushGpuConfig short-circuited, the regenerated compose stripped
      // ipc:host + shm_size + the nvidia deploy block from llm-proxy, the
      // recreated container booted without GPU access, and vLLM crashed.
      const state = makeState({
        platform: 'linux',
        enabledModules: ['jarvis-llm-proxy-api'],
        hardware: null,
      })
      const output = generateCompose(state, registry)
      const start = output.search(/\n {2}jarvis-llm-proxy-api:\n/)
      const block = output.slice(start + 1)
      const blockEnd = block.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
      const llmProxy = blockEnd > 0 ? block.slice(0, blockEnd + 1) : block
      expect(llmProxy).toContain('ipc: host')
      expect(llmProxy).toContain('shm_size: "8gb"')
      expect(llmProxy).toContain('driver: nvidia')
      expect(llmProxy).toContain('capabilities: [gpu]')
    })

    it('does not declare ${VAR}-prefixed host paths at top level', () => {
      // jarvis-admin mounts ${JARVIS_HOST_COMPOSE_DIR:-.}:/host/compose — that's a
      // host path with an env-var prefix; previously the named-volume filter
      // only rejected leading / and ., letting this leak into the top-level
      // volumes: section and triggering "additional properties not allowed".
      const state = makeState({ enabledModules: ['jarvis-admin'] })
      const output = generateCompose(state, registry)
      const volumesBlock = output.slice(output.lastIndexOf('volumes:'))
      expect(output).toContain('${JARVIS_HOST_COMPOSE_DIR:-.}:/host/compose')
      expect(volumesBlock).not.toContain('JARVIS_HOST_COMPOSE_DIR')
    })
  })

  describe('migration entrypoint wrapper', () => {
    // Every service the registry marks `migrate: true` must get the
    // alembic-then-exec entrypoint wrapper so it runs `alembic upgrade head`
    // before serving. Driven by the registry flag — no service-id hardcoding.
    const MIGRATE_SET = registry.services
      .filter((s) => s.migrate)
      .map((s) => s.id)

    // Slice the compose output to a single service's block.
    function serviceBlock(output: string, id: string): string {
      const start = output.indexOf(`\n  ${id}:\n`)
      expect(start, `${id} missing from compose`).toBeGreaterThanOrEqual(0)
      const after = output.slice(start + `\n  ${id}:\n`.length)
      const next = after.match(/\n {2}[a-z][a-z0-9-]*:\n/)
      return next ? after.slice(0, next.index) : after
    }

    // Enable every recommended/optional migrate-set service so they all emit.
    const allMigrateState = makeState({
      platform: 'linux',
      enabledModules: MIGRATE_SET,
      hardware: {
        platform: 'linux',
        arch: 'x86_64',
        totalMemoryGb: 32,
        gpuName: 'NVIDIA RTX 3090',
        gpuVramMb: 24576,
        gpuType: 'nvidia',
        recommendedBackends: ['gguf'],
        recommendedBackend: 'gguf',
      },
    })

    it('marks the expected services as migrate-set in the registry', () => {
      // Regression guard: config-service (the one that 500'd) and the other
      // DB-backed services must carry the flag. jarvis-tts now ships alembic in
      // its image and has DATABASE_URL wired, so it carries the flag too (its
      // settings writes 500'd fleet-wide without it). jarvis-logs stays deferred
      // — its image doesn't ship alembic yet.
      expect(MIGRATE_SET).toEqual(
        expect.arrayContaining([
          'jarvis-config-service',
          'jarvis-auth',
          'jarvis-command-center',
          'jarvis-whisper-api',
          'jarvis-llm-proxy-api',
          'jarvis-notifications',
          'jarvis-tts',
        ]),
      )
      expect(MIGRATE_SET).not.toContain('jarvis-logs')
    })

    it.each(MIGRATE_SET)('emits the alembic entrypoint wrapper for %s', (id) => {
      const output = generateCompose(allMigrateState, registry)
      const block = serviceBlock(output, id)
      expect(block).toContain('entrypoint:')
      expect(block).toContain('- /bin/sh')
      expect(block).toContain('- -c')
      expect(block).toContain('- python -m alembic upgrade head && exec "$@"')
      expect(block).toContain('- jarvis-migrate')
    })

    it('does NOT emit a migrate entrypoint for non-migrate services (jarvis-web)', () => {
      const output = generateCompose(makeState({ enabledModules: ['jarvis-web'] }), registry)
      const block = serviceBlock(output, 'jarvis-web')
      expect(block).not.toContain('alembic upgrade head')
      expect(block).not.toContain('entrypoint:')
    })

    it('gives jarvis-command-center REDIS_URL (it enqueues phone-call dials the gateway consumes)', () => {
      const cc = serviceBlock(generateCompose(makeState({}), registry), 'jarvis-command-center')
      expect(cc).toContain('REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379/0')
    })

    it('gives jarvis-command-center JARVIS_ADAPTER_CALLBACK_TOKEN (async-job callbacks fail-closed 503 without it -> memory-extraction persistence silently dies)', () => {
      const cc = serviceBlock(generateCompose(makeState({}), registry), 'jarvis-command-center')
      expect(cc).toContain('JARVIS_ADAPTER_CALLBACK_TOKEN: ${JARVIS_ADAPTER_CALLBACK_TOKEN}')
    })

    it('keeps an explicit serve command on migrate services with no seed (overriding entrypoint clears image CMD)', () => {
      const output = generateCompose(allMigrateState, registry)
      const cc = serviceBlock(output, 'jarvis-command-center')
      const whisper = serviceBlock(output, 'jarvis-whisper-api')
      // Overriding `entrypoint` CLEARS the image CMD — so the migrate wrapper's
      // `exec "$@"` has nothing to run unless these carry a command. Without it
      // they exit right after migrating (restart-loop, no server).
      expect(cc).toContain('    command:')
      expect(cc).toContain('"uvicorn", "app.main:app"')
      expect(whisper).toContain('    command:')
      expect(whisper).toContain('"uvicorn", "app.main:app"')
    })

    it('INVARIANT: every migrate service emits a non-empty command (no exec "" exit)', () => {
      // Generic class guard — unlike a per-service test, this can't be written to
      // encode the bug. Any migrate service that overrides entrypoint MUST supply
      // a command, or `exec "$@"` runs nothing and the container exits.
      const output = generateCompose(allMigrateState, registry)
      const offenders = MIGRATE_SET.filter((id) => {
        const block = serviceBlock(output, id)
        return block.includes('exec "$@"') && !/\n {4}command:/.test(block)
      })
      expect(
        offenders,
        `migrate services with entrypoint but NO command (exec "" → exit): ${offenders.join(', ')}`,
      ).toEqual([])
    })

    it('llm-proxy runs the supervised scripts/serve.sh, NOT the raw dual-uvicorn pattern', () => {
      const output = generateCompose(allMigrateState, registry)
      const llm = serviceBlock(output, 'jarvis-llm-proxy-api')
      // Entrypoint migrates; the command runs the image's supervised launcher
      // (API foreground + model service respawned with backoff). The old raw
      // `model_service & exec main` left the model service unsupervised — a
      // native crash meant no respawn and the API 503'd forever (2026-07-02
      // outage; roadmap #59).
      expect(llm).toContain('entrypoint:')
      expect(llm).toContain('    command: ["bash", "scripts/serve.sh"]')
      expect(llm).not.toContain('uvicorn services.model_service:app')
      // The command itself must not inline migrations (the entrypoint does that;
      // serve.sh's own alembic run is idempotent).
      expect(llm).not.toContain('command: ["sh", "-c", "python -m alembic')
    })

    it('jarvis-auth serves jarvis_auth.app.main:app, NOT the generic app.main:app', () => {
      // auth is the one migrate service whose app is packaged under `jarvis_auth.`
      // rather than at top-level `app.main`. The generic `app.main:app` crash-loops
      // it with `ModuleNotFoundError: No module named 'app'`, so it never serves
      // /health (the bug that kept the install-e2e sync-live lane red).
      const output = generateCompose(allMigrateState, registry)
      const auth = serviceBlock(output, 'jarvis-auth')
      expect(auth).toContain('    command:')
      expect(auth).toContain('"uvicorn", "jarvis_auth.app.main:app"')
      expect(auth).not.toContain('"uvicorn", "app.main:app"')
    })

    it('serves jarvis-admin on the backend port 7711, not the registry nominal 7710', () => {
      // admin's containerized backend (SPA + API + /health) listens on PORT ?? 7711;
      // the registry's 7710 is only its local "already-installed" redirect target.
      // The compose must publish + set PORT on 7711, or the install-e2e harness's
      // :7711/health probe (and real admin access) miss it. The container
      // healthcheck is NOT emitted here — admin is a Node image with no python, so
      // it uses its own Dockerfile wget HEALTHCHECK (also on 7711); see
      // healthcheck.test.ts.
      const output = generateCompose(makeState({ enabledModules: ['jarvis-admin'] }), registry)
      const admin = serviceBlock(output, 'jarvis-admin')
      expect(admin).toContain('PORT: "7711"')
      expect(admin).toContain('${ADMIN_PORT:-7711}:7711')
      expect(admin).not.toContain('7710')
    })
  })

  describe('command-center prompt-provider volume', () => {
    it('emits the prompt-providers mount under jarvis-command-center', () => {
      const state = makeState({ enabledModules: [] })
      const output = generateCompose(state, registry)
      expect(output).toContain(
        '- command-center-prompt-providers:/app/core/prompt_providers_custom',
      )
      const ccStart = output.indexOf('  jarvis-command-center:\n')
      expect(ccStart).toBeGreaterThanOrEqual(0)
      const afterCc = output.slice(ccStart + '  jarvis-command-center:\n'.length)
      const nextSvcMatch = afterCc.match(/\n {2}[a-z][a-z0-9-]*:\n/)
      const ccBlock = nextSvcMatch
        ? afterCc.slice(0, nextSvcMatch.index)
        : afterCc
      expect(ccBlock).toContain(
        'command-center-prompt-providers:/app/core/prompt_providers_custom',
      )
    })

    it('declares command-center-prompt-providers in the top-level volumes block', () => {
      const state = makeState({ enabledModules: [] })
      const output = generateCompose(state, registry)
      const volumesBlock = output.slice(output.lastIndexOf('volumes:'))
      expect(volumesBlock).toContain('command-center-prompt-providers:')
    })

    it('keeps emitting existing service volumes (regression: whisper-voice-profiles, jarvis-tts-hf-cache)', () => {
      const state = makeState({
        enabledModules: ['jarvis-whisper-api', 'jarvis-tts'],
      })
      const output = generateCompose(state, registry)
      expect(output).toContain('- whisper-voice-profiles:/app/voice_profiles')
      expect(output).toContain('- jarvis-tts-hf-cache:/app/models/hf_cache')
      const volumesBlock = output.slice(output.lastIndexOf('volumes:'))
      expect(volumesBlock).toContain('whisper-voice-profiles:')
      expect(volumesBlock).toContain('jarvis-tts-hf-cache:')
    })
  })
})

describe('compose-generator: pinned project name', () => {
  const registry = loadRegistry()
  it('pins the Compose project name (name: jarvis) above services:', () => {
    const output = generateCompose(makeState(), registry)
    expect(output).toContain('name: jarvis')
    // must be a top-level key, before services:
    expect(output.indexOf('name: jarvis')).toBeGreaterThanOrEqual(0)
    expect(output.indexOf('name: jarvis')).toBeLessThan(output.indexOf('services:'))
  })
})

describe('dockerized URL style', () => {
  it('emits JARVIS_CONFIG_URL_STYLE=dockerized for services so localhost broker resolves', () => {
    const output = generateCompose(makeState({ enabledModules: ['jarvis-notifications'] }), loadRegistry())
    // lets a localhost-registered broker resolve to host.docker.internal for in-Docker
    // services while remote nodes resolve it to the server IP
    expect(output).toContain('JARVIS_CONFIG_URL_STYLE: "dockerized"')
  })
})

describe('P1.4 — data-plane loopback bind + Grafana password', () => {
  const registry = loadRegistry()
  function block(output: string, id: string): string {
    const start = output.indexOf(`\n  ${id}:\n`)
    expect(start, `${id} missing from compose`).toBeGreaterThanOrEqual(0)
    const after = output.slice(start + `\n  ${id}:\n`.length)
    const next = after.match(/\n {2}[a-z][a-z0-9-]*:\n/)
    return next ? after.slice(0, next.index) : after
  }

  it('binds data-plane infra (postgres, redis) to loopback, opt-out via JARVIS_INFRA_BIND_HOST', () => {
    const out = generateCompose(makeState(), registry)
    expect(block(out, 'postgres')).toContain('- "${JARVIS_INFRA_BIND_HOST:-127.0.0.1}:${')
    expect(block(out, 'redis')).toContain('${JARVIS_INFRA_BIND_HOST:-127.0.0.1}:')
  })

  it('does NOT loopback-bind mosquitto (remote nodes must reach it)', () => {
    expect(block(generateCompose(makeState(), registry), 'mosquitto')).not.toContain('JARVIS_INFRA_BIND_HOST')
  })

  // Loki ships no auth of its own and stores voice transcripts. It was
  // previously excluded from DATA_PLANE_INFRA alongside grafana ("dashboards"),
  // which published the raw log API on 0.0.0.0:3100 — readable by anyone on the
  // LAN/VPS. grafana + jarvis-logs reach it over the internal network.
  it('loopback-binds loki — the log store has no auth and holds transcripts', () => {
    expect(block(generateCompose(makeState(), registry), 'loki')).toContain(
      '- "${JARVIS_INFRA_BIND_HOST:-127.0.0.1}:',
    )
  })

  it('still exposes grafana (browser dashboards), protected by its generated password', () => {
    expect(block(generateCompose(makeState(), registry), 'grafana')).not.toContain('JARVIS_INFRA_BIND_HOST')
  })

  it('Grafana uses a generated admin password, never the literal "jarvis"', () => {
    const g = block(generateCompose(makeState(), registry), 'grafana')
    expect(g).toContain('GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD}')
    expect(g).not.toContain('GF_SECURITY_ADMIN_PASSWORD: jarvis')
  })
})

describe('MQTT broker auth', () => {
  const registry = loadRegistry()

  // Slice a top-level compose block (works for both `  mosquitto:` infra and
  // `  jarvis-command-center:` service headers).
  function block(output: string, id: string): string {
    const start = output.indexOf(`\n  ${id}:\n`)
    expect(start, `${id} missing from compose`).toBeGreaterThanOrEqual(0)
    const after = output.slice(start + `\n  ${id}:\n`.length)
    const next = after.match(/\n {2}[a-z][a-z0-9-]*:\n/)
    return next ? after.slice(0, next.index) : after
  }

  it('mosquitto builds a password file from env before launching (no anonymous-only broker)', () => {
    // The generator cannot hash to mosquitto's $7$ PBKDF2 format, so the
    // container runs mosquitto_passwd at startup and points the broker at it.
    const m = block(generateCompose(makeState(), registry), 'mosquitto')
    expect(m).toContain('mosquitto_passwd -b -c /tmp/pwfile')
    expect(m).toContain('password_file /tmp/pwfile')
  })

  it('mosquitto allow_anonymous is env-driven, defaulting to true (safe transition window)', () => {
    // Transition default: a live node that has not adopted creds yet still
    // connects. The operator flips MQTT_ALLOW_ANON=false to lock down.
    // $$ escapes Compose interpolation so the CONTAINER shell expands the env var.
    const m = block(generateCompose(makeState(), registry), 'mosquitto')
    expect(m).toContain('allow_anonymous $$MQTT_ALLOW_ANON')
    expect(m).toContain('MQTT_ALLOW_ANON: ${MQTT_ALLOW_ANON:-true}')
  })

  it('mosquitto receives the shared MQTT credential via env', () => {
    const m = block(generateCompose(makeState(), registry), 'mosquitto')
    expect(m).toContain('MQTT_USERNAME: ${MQTT_USERNAME:-jarvis}')
    expect(m).toContain('MQTT_PASSWORD: ${MQTT_PASSWORD}')
  })

  it('command-center gets the same MQTT credential so it authenticates to the broker', () => {
    // CC's get_mqtt_credentials() reads MQTT_USERNAME/MQTT_PASSWORD from env.
    const cc = block(generateCompose(makeState({ enabledModules: [] }), registry), 'jarvis-command-center')
    expect(cc).toContain('MQTT_USERNAME: jarvis')
    expect(cc).toContain('MQTT_PASSWORD: ${MQTT_PASSWORD}')
  })
})

describe('jarvis-phone-gateway (optional service, phone-calls PRD)', () => {
  const registry = loadRegistry()

  function gwBlock(output: string): string {
    const start = output.indexOf('\n  jarvis-phone-gateway:\n')
    expect(start, 'jarvis-phone-gateway missing from compose').toBeGreaterThanOrEqual(0)
    const after = output.slice(start + '\n  jarvis-phone-gateway:\n'.length)
    const next = after.match(/\n {2}[a-z][a-z0-9-]*:\n/)
    return next ? after.slice(0, next.index) : after
  }

  it('is excluded unless enabled (optional, default off)', () => {
    const output = generateCompose(makeState({ enabledModules: [] }), registry)
    expect(output).not.toContain('jarvis-phone-gateway:')
  })

  it('emits a standard first-party block when enabled', () => {
    const output = generateCompose(
      makeState({ enabledModules: ['jarvis-phone-gateway'] }),
      registry,
    )
    const gw = gwBlock(output)
    expect(gw).toContain('container_name: jarvis-phone-gateway')
    expect(gw).toContain('"${JARVIS_SERVICE_BIND_HOST:-127.0.0.1}:${PHONE_GATEWAY_PORT:-7713}:7713"')
    expect(gw).toContain('PORT: "7713"')
    // Dial queue transport
    expect(gw).toContain('REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379/0')
    // Twilio secrets come from .env placeholders, degrade to empty (fail closed)
    expect(gw).toContain('TWILIO_ACCOUNT_SID: ${TWILIO_ACCOUNT_SID:-}')
    expect(gw).toContain('TWILIO_AUTH_TOKEN: ${TWILIO_AUTH_TOKEN:-}')
    expect(gw).toContain('TWILIO_FROM_NUMBER: ${TWILIO_FROM_NUMBER:-}')
    expect(gw).toContain('PHONE_GATEWAY_PUBLIC_WSS_URL: ${PHONE_GATEWAY_PUBLIC_WSS_URL:-}')
    // Standard first-party plumbing
    expect(gw).toContain('JARVIS_APP_ID: ${JARVIS_APP_ID_PHONE_GATEWAY:-}')
    expect(gw).toContain('JARVIS_AUTH_BASE_URL:')
    // CC base URL for the dial worker's session fetch — prod 2026-08-07: absent →
    // gateway defaulted to localhost → every dial job dropped ("session fetch failed")
    expect(gw).toContain('JARVIS_COMMAND_CENTER_BASE_URL: http://host.docker.internal:${COMMAND_CENTER_PORT:-7703}')
    expect(gw).toContain('healthcheck:')
    expect(gw).toContain("urllib.request.urlopen('http://localhost:7713/health')")
    expect(gw).toContain('restart: unless-stopped')
    // No database → no migrate entrypoint, no DATABASE_URL
    expect(gw).not.toContain('DATABASE_URL')
    expect(gw).not.toContain('jarvis-migrate')
    // Startup ordering
    expect(gw).toContain('depends_on:')
    expect(gw).toContain('jarvis-command-center:')
  })
})

describe('nativeOnly services (jarvis-osx-api)', () => {
  const registry = loadRegistry()

  it('registry entry exists, is optional, nativeCapable and nativeOnly', () => {
    const svc = registry.services.find((s) => s.id === 'jarvis-osx-api')
    expect(svc).toBeDefined()
    expect(svc?.category).toBe('optional')
    expect(svc?.port).toBe(7723)
    expect(svc?.nativeCapable).toBe(true)
    expect(svc?.nativeOnly).toBe(true)
  })

  it('is NEVER emitted to compose on linux, even when enabled', () => {
    const state = makeState({
      platform: 'linux',
      enabledModules: ['jarvis-whisper-api', 'jarvis-tts', 'jarvis-osx-api'],
    })
    expect(getComposeServices(state, registry).map((s) => s.id)).not.toContain('jarvis-osx-api')
    expect(generateCompose(state, registry)).not.toContain('jarvis-osx-api')
  })

  it('is NEVER emitted to compose on darwin, even without native opt-in', () => {
    const state = makeState({
      platform: 'darwin',
      enabledModules: ['jarvis-whisper-api', 'jarvis-tts', 'jarvis-osx-api'],
      nativeServices: [], // user did NOT opt it into native mode — still excluded
    })
    expect(getComposeServices(state, registry).map((s) => s.id)).not.toContain('jarvis-osx-api')
    expect(generateCompose(state, registry)).not.toContain('jarvis-osx-api')
  })

  it('stays out of compose when NOT enabled (baseline)', () => {
    const state = makeState({ platform: 'linux' })
    expect(generateCompose(state, registry)).not.toContain('jarvis-osx-api')
  })
})

describe('compose-generator: llama-server sidecar (servingType)', () => {
  const registry = loadRegistry()

  it('emits the llama-server sidecar as a first-class, compose-only service when servingType=llama-server on linux', () => {
    const out = generateCompose(makeState({ servingType: 'llama-server', platform: 'linux' }), registry)
    // First-class generated service — survives a regen (the docker-compose.override.yml footgun fix)
    expect(out).toContain('container_name: llama-server')
    // Pinned to a DIGEST, never the floating :server-cuda tag — a `docker compose
    // pull` must not silently swap the inference engine out from under prod
    // (prod & dev had drifted to different builds before this pin).
    expect(out).toContain('image: ghcr.io/ggml-org/llama.cpp@sha256:')
    expect(out).not.toContain('llama.cpp:server-cuda')
    expect(out).toContain('${LLAMA_SERVER_PORT:-7799}:8080')
    expect(out).toContain('${MODELS_DIR:-./.models}:/models:ro')
    // Env-parametrized command so Phase 2 can retarget the live model via .env (no YAML edit)
    expect(out).toContain('/models/${LIVE_MODEL_FILE}')
    expect(out).toContain('${LIVE_MODEL_CHAT_TEMPLATE:-chatml}')
    // ctx defaults to 24576 (was 32768): the model must fit a SINGLE card once
    // pinned — max observed prod prompt is 16.6k tokens, so 24k has headroom.
    expect(out).toContain('${LIVE_MODEL_CTX:-24576}')
    // Preserve prod's exact command for a zero-gap migration: -ctxcp / -cms
    expect(out).toContain('${LIVE_MODEL_CTXCP:-32}')
    expect(out).toContain('${LIVE_MODEL_CMS:-256}')
    const block = out.slice(out.indexOf('  llama-server:'))
    const service = block.split(/\n {2}\S/)[0]!
    // Pinned to ONE gpu (default GPU1, with kokoro): count: all layer-split the
    // model across both 3090s → cross-GPU sync on every live-voice token
    // (prod 2026-08-15).
    expect(service).toContain("device_ids: ['${LIVE_MODEL_GPU_DEVICE:-1}']")
    expect(service).not.toContain('count: all')
    // It is NOT a Jarvis app: no app-to-app creds injected into the sidecar block.
    expect(service).not.toContain('JARVIS_APP_ID')
  })

  it('does NOT emit the sidecar for the default (llama-cpp) serving type', () => {
    const out = generateCompose(makeState(), registry)
    expect(out).not.toContain('container_name: llama-server')
    // Repo-level absence (the image is digest-pinned now, so :server-cuda alone
    // would no longer catch a wrongly-emitted sidecar).
    expect(out).not.toContain('ghcr.io/ggml-org/llama.cpp')
  })

  it('does NOT emit the sidecar on macOS even when servingType=llama-server', () => {
    const out = generateCompose(makeState({ servingType: 'llama-server', platform: 'darwin' }), registry)
    expect(out).not.toContain('container_name: llama-server')
  })
})

describe('compose-generator: llama-server-bg sidecar (bgModelEnabled)', () => {
  const registry = loadRegistry()

  it('emits the background sidecar with --jinja (no chatml override) when enabled on linux', () => {
    const out = generateCompose(makeState({ bgModelEnabled: true, platform: 'linux' }), registry)
    expect(out).toContain('container_name: llama-server-bg')
    expect(out).toContain('${LLAMA_SERVER_BG_PORT:-7798}:8080')
    expect(out).toContain('/models/${BG_MODEL_FILE}')
    expect(out).toContain('${BG_MODEL_CTX:-32768}')
    expect(out).toContain('${BG_MODEL_NP:-2}')
    // --jinja renders the model's EMBEDDED template (reasoning-effort default +
    // per-request enable_thinking). A chatml override would discard it — assert
    // the bg block carries --jinja and NO --chat-template.
    const block = out.slice(out.indexOf('  llama-server-bg:'))
    const service = block.split(/\n {2}\S/)[0]!
    expect(service).toContain('"--jinja"')
    expect(service).not.toContain('--chat-template')
    expect(service).not.toContain('JARVIS_APP_ID')
    // Pinned to ONE gpu (default GPU0, with whisper) so background thinking
    // never contends with live voice on GPU1 (prod 2026-08-15).
    expect(service).toContain("device_ids: ['${BG_MODEL_GPU_DEVICE:-0}']")
    expect(service).not.toContain('count: all')
  })

  it('coexists with the live llama-server sidecar (both blocks emitted)', () => {
    const out = generateCompose(
      makeState({ servingType: 'llama-server', bgModelEnabled: true, platform: 'linux' }),
      registry,
    )
    expect(out).toContain('container_name: llama-server\n')
    expect(out).toContain('container_name: llama-server-bg')
  })

  it('does NOT emit the background sidecar by default', () => {
    const out = generateCompose(makeState({ platform: 'linux' }), registry)
    expect(out).not.toContain('llama-server-bg')
  })

  it('does NOT emit the background sidecar on macOS even when enabled', () => {
    const out = generateCompose(makeState({ bgModelEnabled: true, platform: 'darwin' }), registry)
    expect(out).not.toContain('llama-server-bg')
  })
})
