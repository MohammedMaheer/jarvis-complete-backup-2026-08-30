export type GpuType = 'nvidia' | 'amd' | 'amd-rocm' | 'apple' | 'none'

/**
 * Whisper GPU backend, chosen explicitly and independently of the LLM gpuType.
 * Default "cpu" — Whisper's base.en is fast on CPU and leaves the GPU for the LLM.
 * Maps to the whisper image suffix: cpu "" / cuda "-cuda" / vulkan "-vulkan" / rocm "-rocm".
 */
export type WhisperBackend = 'cpu' | 'cuda' | 'vulkan' | 'rocm'

/**
 * TTS (Kokoro) inference device, chosen explicitly. Default "cpu" — Kokoro is
 * an 82M-param model and CPU synth is sub-second per sentence. Unlike whisper
 * this controls device passthrough only: the stock jarvis-tts image ships
 * CUDA-capable torch, so no image variant exists or is needed.
 */
export type TtsBackend = 'cpu' | 'cuda'

/**
 * How the LIVE voice model is served.
 *  - 'llama-cpp'    : in-process GGUF inside jarvis-llm-proxy-api (default; today's behavior).
 *  - 'vllm'         : in-process vLLM (HF/safetensors) inside the proxy.
 *  - 'llama-server' : a standalone llama.cpp `llama-server` sidecar the proxy calls over REST.
 *                     NVIDIA/Linux only. Emitted as a first-class compose service so a regen
 *                     can't silently drop it (the docker-compose.override.yml footgun).
 */
export type ServingType = 'vllm' | 'llama-cpp' | 'llama-server'

export interface HardwareInfo {
  platform: 'darwin' | 'linux'
  arch: string
  totalMemoryGb: number
  gpuName: string | null
  gpuVramMb: number | null
  gpuType: GpuType
  recommendedBackends: string[]
  recommendedBackend: string
}

export interface WizardState {
  currentStep: number
  totalSteps: number

  // Step 1: Services
  enabledModules: string[]

  // Step 2: Configuration
  portOverrides: Record<string, number>
  infraPortOverrides: Record<string, number>
  secrets: Record<string, string>
  dbUser: string
  whisperModel: string
  whisperModelPath: string
  /** Explicit Whisper GPU backend (default "cpu" when unset). Independent of hardware.gpuType. */
  whisperBackend?: WhisperBackend
  /** Explicit TTS (Kokoro) device (default "cpu"). Device passthrough only — no image variant. */
  ttsBackend?: TtsBackend
  /** Opt-in digest pinning (PIN_IMAGES). Default false: floating tags so `docker compose pull` updates. */
  pinImages?: boolean
  llmInterface: string
  /**
   * How the live voice model is served (default 'llama-cpp' = in-process GGUF).
   * When 'llama-server', the generator emits the standalone `llama-server` sidecar
   * (NVIDIA/Linux only) parametrized by the LIVE_MODEL_* env vars.
   */
  servingType?: ServingType
  /**
   * Background-model sidecar (llama-server-bg) for the proxy's BACKGROUND slot.
   * When true, the generator emits a second llama.cpp sidecar (NVIDIA/Linux only)
   * parametrized by the BG_MODEL_* env vars, launched with --jinja so reasoning
   * models keep their embedded chat template. Durable key: BG_MODEL_ENABLED.
   */
  bgModelEnabled?: boolean
  /** GGUF filename (relative to the models dir) served by llama-server-bg. */
  bgModelFile?: string

  // New: deployment mode
  deploymentMode: 'local' | 'remote-llm'
  deploymentTarget: 'standard' | 'compose-export'
  remoteLlmUrl: string
  remoteWhisperUrl: string
  platform: 'darwin' | 'linux'
  hardware: HardwareInfo | null
  /** Jarvis Relay (OAuth callback proxy + Expo Push at https://relay.jarvisautomation.io). */
  relayEnabled: boolean
  relayUrl: string
  /**
   * Household JWT for jarvis-notifications → relay /v1/send. Signed by the
   * relay's RELAY_JWT_SECRET; carries household_id and an expiry. Without it,
   * the notifications service has no way to authenticate to the relay and
   * push delivery silently no-ops.
   */
  relayHouseholdJwt?: string
  /** Docker image tag track: stable uses :latest, dev uses :dev. */
  releaseTrack: 'stable' | 'dev'
  /**
   * Absolute HOST path to the compose directory, for admin-in-docker reconciles.
   * When set, env-generator writes MODELS_DIR=<this>/.models so the generated
   * compose's bind mount resolves to a real host directory rather than the
   * admin container's view (which is invisible to the docker daemon).
   */
  hostComposePath?: string

  /**
   * Service IDs the user has opted to run natively (macOS only). These are
   * excluded from the generated docker-compose.yml — instead they run via
   * launchd against a local checkout, so they can use Metal / MLX / MPS.
   * Empty on Linux. Populated on Darwin by the wizard's "native services" step.
   */
  nativeServices: string[]
}

export interface InstallStatus {
  configured: boolean
  composePath?: string
  reason?: string
}

export interface HealthStatus {
  [serviceId: string]: {
    healthy: boolean
    url: string
    error?: string
  }
}

export interface RegisterResult {
  registered: string[]
  failed: Array<{ serviceId: string; error: string }>
  needsRestart: boolean
  appKeys?: Record<string, { appId: string; appKey: string }>
}

export interface ServiceHealthResult {
  healthy: boolean
  error?: string
}

export interface TieredStartupResult {
  success: boolean
  error?: string
  serviceHealth?: Record<string, ServiceHealthResult>
}

export interface PreflightCheck {
  name: string
  status: 'pass' | 'warn' | 'fail'
  message: string
  details?: string
}

export interface PreflightResult {
  checks: PreflightCheck[]
  canProceed: boolean
}

export interface InstallState {
  configured: boolean
  composePath?: string
  reason?: string
  state?: 'fresh' | 'generated' | 'partial' | 'running' | 'complete' | 'offline' | 'deployed-needs-account'
  running?: string[]
  stopped?: string[]
  deployMode?: 'standard' | 'compose-export'
}
