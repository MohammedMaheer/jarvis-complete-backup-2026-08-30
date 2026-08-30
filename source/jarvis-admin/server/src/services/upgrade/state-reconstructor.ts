import { arch, totalmem } from 'node:os'
import type { HardwareInfo, ServingType, TtsBackend, WhisperBackend, WizardState } from '../../types/wizard.js'
import type { ServiceRegistry } from '../../types/service-registry.js'
import { serviceIdToPortVar } from '../generators/port-utils.js'
import { SECRET_KEYS } from '../generators/secret-generator.js'
import { detectGpuType } from '../hardware-detect.js'
import { getHostPlatform } from '../host-platform.js'

/**
 * Reconstruct a WizardState from an existing .env file so we can
 * regenerate docker-compose.yml without losing the user's configuration.
 */
export function reconstructWizardState(
  existingEnv: Record<string, string>,
  registry: ServiceRegistry,
): WizardState {
  // Determine enabled modules by checking which port vars exist
  const enabledModules: string[] = []
  for (const svc of registry.services) {
    if (svc.category === 'core') continue // Core always included
    const portVar = serviceIdToPortVar(svc.id)
    if (existingEnv[portVar]) {
      enabledModules.push(svc.id)
    }
  }

  // Reconstruct port overrides
  const portOverrides: Record<string, number> = {}
  for (const svc of registry.services) {
    const portVar = serviceIdToPortVar(svc.id)
    const val = existingEnv[portVar]
    if (val && parseInt(val, 10) !== svc.port) {
      portOverrides[svc.id] = parseInt(val, 10)
    }
  }

  const infraPortOverrides: Record<string, number> = {}
  for (const inf of registry.infrastructure) {
    const portVar = serviceIdToPortVar(inf.id)
    const val = existingEnv[portVar]
    if (val && parseInt(val, 10) !== inf.port) {
      infraPortOverrides[inf.id] = parseInt(val, 10)
    }
  }

  // Reconstruct secrets
  const secrets: Record<string, string> = {}
  for (const key of SECRET_KEYS) {
    if (existingEnv[key]) {
      secrets[key] = existingEnv[key]!
    }
  }

  // Detect deployment mode
  const hasRemoteLlm = !!existingEnv.JARVIS_LLM_PROXY_URL
  const deploymentMode = hasRemoteLlm ? 'remote-llm' as const : 'local' as const

  // Native services (macOS only). Reconcile flows must keep these excluded
  // from compose; the value is written by env-generator on first install.
  const nativeServicesRaw = existingEnv.JARVIS_NATIVE_SERVICES ?? ''
  const nativeServices = nativeServicesRaw
    ? nativeServicesRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : []

  // Whisper backend: which image variant (cpu/cuda/vulkan/rocm) the compose
  // emits for jarvis-whisper-api. Persisted in .env by env-generator because
  // the digest-pinned compose is the only other place the choice is visible.
  // Unrecognized/missing values degrade to cpu — never fail a reconcile on it.
  const WHISPER_BACKENDS: ReadonlySet<string> = new Set(['cpu', 'cuda', 'vulkan', 'rocm'])
  const whisperBackend: WhisperBackend = WHISPER_BACKENDS.has(existingEnv.WHISPER_BACKEND ?? '')
    ? (existingEnv.WHISPER_BACKEND as WhisperBackend)
    : 'cpu'

  // TTS device — same persistence contract as whisperBackend (see above).
  const ttsBackend: TtsBackend = existingEnv.TTS_BACKEND === 'cuda' ? 'cuda' : 'cpu'

  // Live-model serving type. SERVING_TYPE is authoritative; if absent, INFER it
  // so a reconcile of a box that somehow lost the key can't silently drop the
  // sidecar (the whole point of this fix): a LIVE_MODEL_FILE means the
  // llama-server sidecar was serving live; else JARVIS_MODEL_BACKEND=VLLM → vllm;
  // else the in-process GGUF default.
  const SERVING_TYPES: ReadonlySet<string> = new Set(['vllm', 'llama-cpp', 'llama-server'])
  const servingType: ServingType = SERVING_TYPES.has(existingEnv.SERVING_TYPE ?? '')
    ? (existingEnv.SERVING_TYPE as ServingType)
    : existingEnv.LIVE_MODEL_FILE
      ? 'llama-server'
      : (existingEnv.JARVIS_MODEL_BACKEND ?? '').toUpperCase() === 'VLLM'
        ? 'vllm'
        : 'llama-cpp'

  // Background-model sidecar. BG_MODEL_ENABLED is authoritative; if absent,
  // infer from a set BG_MODEL_FILE (same never-silently-drop-the-sidecar
  // contract as SERVING_TYPE above).
  const bgModelEnabled =
    existingEnv.BG_MODEL_ENABLED === 'true' ||
    (existingEnv.BG_MODEL_ENABLED === undefined && !!existingEnv.BG_MODEL_FILE)
  const bgModelFile = existingEnv.BG_MODEL_FILE || ''

  // Image pinning: opt-in only. Missing key = floating tags (this is also
  // the migration path — pre-existing pinned installs heal to floating tags
  // on their next regen, ending the stale-pin stranding class).
  const pinImages = existingEnv.PIN_IMAGES === 'true'

  // Detect relay
  const relayEnabled = !!existingEnv.JARVIS_RELAY_URL
  const relayUrl = existingEnv.JARVIS_RELAY_URL || ''
  const relayHouseholdJwt = existingEnv.JARVIS_RELAY_HOUSEHOLD_JWT || ''

  // Re-detect hardware at reconcile time. The .env doesn't store the user's
  // original wizard hardware selection, so without this, state.hardware stays
  // null, getServiceImage skips variant suffixes, and pushGpuConfig strips
  // GPU runtime config from gpu: true services on regenerate.
  // Use host detection (env override + docker-info), not process.platform —
  // admin runs in a Linux container even on Mac hosts.
  const detected = getHostPlatform()
  const plat: 'darwin' | 'linux' = detected === 'darwin' ? 'darwin' : 'linux'
  const gpuType = detectGpuType()
  const hardware: HardwareInfo = {
    platform: plat,
    arch: arch(),
    totalMemoryGb: Math.round(totalmem() / (1024 * 1024 * 1024)),
    gpuName: null,
    gpuVramMb: null,
    gpuType,
    recommendedBackends: [],
    recommendedBackend: 'gguf',
  }

  return {
    currentStep: 0,
    totalSteps: 0,
    platform: plat,
    hardware,
    enabledModules,
    portOverrides,
    infraPortOverrides,
    secrets,
    dbUser: existingEnv.DB_USER ?? 'jarvis',
    deploymentMode,
    remoteLlmUrl: existingEnv.JARVIS_LLM_PROXY_URL ?? '',
    remoteWhisperUrl: existingEnv.JARVIS_WHISPER_URL ?? '',
    whisperModel: existingEnv.WHISPER_MODEL?.match(/ggml-(.+)\.bin$/)?.[1] ?? 'base.en',
    whisperModelPath: existingEnv.WHISPER_MODEL ?? '/whisper-models/ggml-base.en.bin',
    whisperBackend,
    ttsBackend,
    pinImages,
    servingType,
    bgModelEnabled,
    bgModelFile,
    llmInterface: existingEnv.LLM_INTERFACE_SEED ?? '',
    deploymentTarget: 'standard',
    releaseTrack: existingEnv.JARVIS_IMAGE_TAG === 'dev' ? 'dev' as const : 'stable' as const,
    relayEnabled,
    relayUrl,
    relayHouseholdJwt,
    nativeServices,
  }
}
