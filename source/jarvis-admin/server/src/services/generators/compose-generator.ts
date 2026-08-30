// Compose file generator — produces docker-compose.yml from wizard state
import type { WizardState } from '../../types/wizard.js'
import type {
  ServiceRegistry,
  ServiceDefinition,
  InfrastructureDefinition,
  WorkerDefinition,
} from '../../types/service-registry.js'
import {
  getCoreServices,
  getRecommendedServices,
  getOptionalServices,
  getRequiredInfrastructure,
} from './service-registry.js'
import imageDigests from '../../data/image-digests.json' with { type: 'json' }

/** repo name -> full tag (track+variant suffix, e.g. "latest-cuda") -> "sha256:…" */
export type ImageDigestMap = Record<string, Record<string, string>>

/**
 * Pin a first-party image by `@sha256` digest when one is recorded for this
 * `(repo, track+suffix)`, so a GHCR tag overwrite can't change what a generated
 * compose pulls. Falls back to the floating `${JARVIS_IMAGE_TAG}` tag when no
 * digest is recorded (offline installs, or before the digest map is refreshed) —
 * a missing digest degrades gracefully, it never breaks generation.
 */
export function pinnedOrTaggedImage(
  baseImage: string,
  track: string,
  suffix: string,
  digests: ImageDigestMap = imageDigests as ImageDigestMap,
  pinImages: boolean = false,
): string {
  // Floating tags are the DEFAULT (2026-07-06 decision): digest pins as a
  // default meant `docker compose pull` could never update anything, stale
  // maps silently downgraded GPU services, and a stuck non-expert operator
  // has no way out. `pinImages` (PIN_IMAGES=true in .env) opts back in to
  // digest pinning for supply-chain-hardened installs — a GHCR tag overwrite
  // can't change what a pinned compose pulls.
  // The dev track ALWAYS floats regardless (mirrors jarvis-installer#17):
  // dev exists to run the freshest CI-built images.
  const repo = baseImage.slice(baseImage.lastIndexOf('/') + 1)
  const digest = !pinImages || track === 'dev'
    ? undefined
    : digests[repo]?.[`${track}${suffix}`]
  if (digest) return `${baseImage}@${digest}`
  return `${baseImage}:\${JARVIS_IMAGE_TAG:-latest}${suffix}`
}
import { serviceIdToPortVar } from './port-utils.js'

/**
 * Returns all enabled services (core + selected recommended + selected optional).
 * On macOS (darwin), filters out GPU services (e.g., llm-proxy) that run natively.
 */
export function getAllEnabledServices(
  state: WizardState,
  registry: ServiceRegistry,
): ServiceDefinition[] {
  const core = getCoreServices(registry)
  const enabledRecommended = getRecommendedServices(registry).filter((s) =>
    state.enabledModules.includes(s.id),
  )
  const enabledOptional = getOptionalServices(registry).filter((s) =>
    state.enabledModules.includes(s.id),
  )
  return [...core, ...enabledRecommended, ...enabledOptional]
}

/**
 * Returns services to include in docker-compose.
 *
 * On macOS the filter has three layers:
 *   1. GPU-required services without a `cpuFallback` image (e.g. legacy
 *      llm-proxy) are always excluded — Docker on Mac can't reach the GPU,
 *      so the container would be useless.
 *   2. Any service the user explicitly opted into native mode (via the
 *      wizard's native-services step → WizardState.nativeServices) is also
 *      excluded; it'll be installed as a LaunchAgent instead.
 *   3. jarvis-admin is ALWAYS excluded on macOS — it runs as the native
 *      binary (the same process that generated this compose), never as a
 *      container. A containerized admin on Docker Desktop can't manage the
 *      compose correctly: it sees the compose at its bind mount (/host/compose)
 *      and Docker Desktop refuses to share the derived host paths (e.g.
 *      /host/compose/init-db.sh), so postgres can't start and the DB-backed
 *      services crash-loop. (2026-07-10 regression from moving admin to core.)
 */
export function getComposeServices(
  state: WizardState,
  registry: ServiceRegistry,
): ServiceDefinition[] {
  // nativeOnly services (e.g. jarvis-osx-api) are excluded UNCONDITIONALLY —
  // on every platform, regardless of native opt-in. They have no Docker image;
  // leaking one into a Linux/prod compose yields an unpullable service.
  const all = getAllEnabledServices(state, registry).filter((s) => !s.nativeOnly)
  const nativeIds = new Set(state.nativeServices ?? [])
  if (state.platform === 'darwin') {
    return all.filter((s) => {
      if (s.id === 'jarvis-admin') return false
      if (nativeIds.has(s.id)) return false
      if (s.gpu && !s.cpuFallback) return false
      return true
    })
  }
  return all
}

/**
 * GPU types we publish image variants for on `cpuFallback` services.
 * Other GPU types (amd Vulkan, none) fall back to the plain CPU image.
 */
const CPU_FALLBACK_GPU_VARIANTS = new Set<string>(['nvidia', 'amd-rocm'])

const FIRST_PARTY_PREFIX = 'ghcr.io/alexberardi/'

// Node-based first-party images (no python in the image). The default python
// urllib healthcheck can't run in these, so we omit it and let each image's own
// Dockerfile HEALTHCHECK (wget) apply instead — otherwise the container is
// pinned "unhealthy" with `exec: "python": executable file not found`.
const NODE_HEALTHCHECK_SERVICES = new Set<string>(['jarvis-web', 'jarvis-admin'])

// Data-plane infra that holds persistent state/secrets and should NOT be
// reachable off-host by default. Their published ports bind to 127.0.0.1 (other
// containers still reach them over the internal `jarvis` network). Opt back out
// via JARVIS_INFRA_BIND_HOST=0.0.0.0.
//
// Loki belongs here: it ships NO authentication of its own, and it stores voice
// transcripts. Grafana is the dashboard (and is protected by a generated admin
// password); Loki is the raw log API behind it, reached over the internal
// network by grafana and jarvis-logs — nothing needs it published off-host.
//
// Infra that legitimately serves external clients — mosquitto (remote nodes)
// and grafana (browser dashboards) — stays on all interfaces.
const DATA_PLANE_INFRA = new Set<string>(['postgres', 'redis', 'minio', 'loki'])

function infraBindPrefix(infraId: string): string {
  return DATA_PLANE_INFRA.has(infraId) ? '${JARVIS_INFRA_BIND_HOST:-127.0.0.1}:' : ''
}

// Whisper's variant is chosen EXPLICITLY via state.whisperBackend (default "cpu"),
// independent of the auto-detected LLM gpuType. WHISPER_BACKEND_GPU maps the
// selection to the gpuType the device emitter understands.
const WHISPER_BACKEND_SUFFIX: Record<string, string> = {
  cpu: '',
  cuda: '-cuda',
  vulkan: '-vulkan',
  rocm: '-rocm',
}
const WHISPER_BACKEND_GPU: Record<string, string> = {
  cpu: 'none',
  cuda: 'nvidia',
  vulkan: 'amd',
  rocm: 'amd-rocm',
}

/** Whether a service should use a GPU image variant + GPU runtime config for the host. */
function shouldUseGpuVariant(service: ServiceDefinition, gpuType: string | undefined): boolean {
  if (!service.gpu || !gpuType) return false
  if (service.cpuFallback && !CPU_FALLBACK_GPU_VARIANTS.has(gpuType)) return false
  return true
}

/** Worker container IDs emitted alongside the given services in the compose file. */
export function getComposeWorkerIds(services: ServiceDefinition[]): string[] {
  return services.flatMap((s) => (s.workers ?? []).map((w) => w.id))
}

/**
 * Returns all required infrastructure for the enabled services,
 * plus grafana (if loki is present) and redis (always).
 */
function getInfraForServices(
  enabledIds: string[],
  registry: ServiceRegistry,
): InfrastructureDefinition[] {
  const infra = getRequiredInfrastructure(registry, enabledIds)

  const hasLoki = infra.some((i) => i.id === 'loki')
  const grafana = registry.infrastructure.find((i) => i.id === 'grafana')
  if (hasLoki && grafana && !infra.some((i) => i.id === 'grafana')) {
    infra.push(grafana)
  }

  const redis = registry.infrastructure.find((i) => i.id === 'redis')
  if (redis && !infra.some((i) => i.id === 'redis')) {
    infra.push(redis)
  }

  return infra
}

export function generateCompose(
  state: WizardState,
  registry: ServiceRegistry,
  digests?: ImageDigestMap,
): string {
  const composeServices = getComposeServices(state, registry)
  const enabledIds = composeServices.map((s) => s.id)
  const infra = getInfraForServices(enabledIds, registry)

  const lines: string[] = []

  // Pin the Compose project name. The services use fixed `container_name:`s but
  // had no top-level `name:`, so Compose derived the project from the directory
  // it ran in — and the admin (in a container) resolves a different dir than the
  // host, so `up` thought none of the running containers were "its" project and
  // tried to CREATE fresh ones → "container name already in use" on jarvis-loki
  // etc. Pinning `name: jarvis` makes the project identity-stable everywhere.
  // (2026-06 reconcile incident.)
  lines.push('name: jarvis')

  lines.push('services:')

  // Infrastructure first
  for (const inf of infra) {
    lines.push('')
    lines.push(...generateInfraBlock(inf, state))
  }

  // Application services (and any sibling workers)
  for (const service of composeServices) {
    lines.push('')
    lines.push(...generateServiceBlock(service, state, registry, digests))
    if (service.workers) {
      for (const worker of service.workers) {
        lines.push('')
        lines.push(...generateWorkerBlock(worker, service, state, registry, digests))
      }
    }
  }

  // Live-model sidecar (llama-server) — a first-class generated service so a
  // compose regen can never silently drop it. NVIDIA/Linux only; the proxy
  // reaches it at http://llama-server:8080 (model.live.backend=REST, set in the DB).
  if (state.servingType === 'llama-server' && state.platform !== 'darwin') {
    lines.push('')
    lines.push(...generateLlamaServerBlock())
  }

  // Background-model sidecar (llama-server-bg) — a second llama.cpp instance for
  // the proxy's BACKGROUND slot (queue jobs, errand planner) so reasoning models
  // can think without touching live voice. Same first-class treatment as
  // llama-server: a regen can never silently drop it. Gated on the durable
  // BG_MODEL_ENABLED env key (see state-reconstructor).
  if (state.bgModelEnabled && state.platform !== 'darwin') {
    lines.push('')
    lines.push(...generateLlamaServerBgBlock())
  }

  // Networks
  lines.push('')
  lines.push('networks:')
  lines.push('  jarvis:')
  lines.push('    driver: bridge')

  // Volumes (top-level): collect named volumes from infra AND services.
  // A volume entry like `name:/path/in/container` is named; bind mounts
  // (e.g. `/var/run/docker.sock:...` or `./path:...`) are not declared here.
  lines.push('')
  lines.push('volumes:')
  const volumes = new Set<string>()
  // A Docker named volume identifier is alphanumeric with limited punctuation.
  // Anything containing /, ., $, or starting with one of those is a host path
  // (bind mount) and must NOT appear in the top-level volumes: section.
  const NAMED_VOLUME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
  const addIfNamed = (vol: string) => {
    const source = vol.split(':')[0]!
    if (source && NAMED_VOLUME_RE.test(source)) {
      volumes.add(source)
    }
  }
  for (const inf of infra) {
    for (const vol of inf.volumes) addIfNamed(vol)
  }
  for (const svc of composeServices) {
    if (svc.volumes) {
      for (const vol of svc.volumes) addIfNamed(vol)
    }
  }
  for (const vol of volumes) {
    lines.push(`  ${vol}:`)
  }

  lines.push('')
  return lines.join('\n')
}

function generateInfraBlock(
  infra: InfrastructureDefinition,
  state: WizardState,
): string[] {
  const lines: string[] = []
  const portVar = serviceIdToPortVar(infra.id)
  const hostPort = state.infraPortOverrides[infra.id] ?? infra.port

  lines.push(`  ${infra.id}:`)
  lines.push(`    image: ${infra.image}`)
  lines.push(`    container_name: jarvis-${infra.id}`)

  if (infra.port) {
    lines.push('    ports:')
    lines.push(`      - "${infraBindPrefix(infra.id)}\${${portVar}:-${hostPort}}:${infra.port}"`)
    if (infra.id === 'mosquitto') {
      // WebSocket listener for external nodes via Cloudflare Tunnel
      lines.push('      - "${MOSQUITTO_WS_PORT:-9883}:9001"')
    }
  }

  // Environment
  if (infra.envVars.length > 0) {
    lines.push('    environment:')
    for (const env of infra.envVars) {
      if (env.secretRef) {
        lines.push(`      ${env.name}: \${${env.secretRef}}`)
      } else {
        const value = env.default ?? ''
        lines.push(`      ${env.name}: \${${env.name}:-${value}}`)
      }
    }
  }

  // Redis needs a command for password auth
  if (infra.id === 'redis') {
    lines.push('    command: redis-server --requirepass ${REDIS_PASSWORD}')
  }

  // Mosquitto: hash the shared MQTT credential into a password_file at startup
  // (the generator can't produce mosquitto's $7$ PBKDF2 hash itself), then serve
  // two listeners — raw MQTT on 1884 (LAN nodes) and WebSockets on 9001 (external
  // nodes via Cloudflare Tunnel; CF terminates TLS). allow_anonymous is env-driven
  // and defaults true so the broker still accepts un-migrated clients while
  // credentials roll out; flip MQTT_ALLOW_ANON=false to lock it down. The `$$`
  // escapes Compose interpolation so the CONTAINER shell expands the env vars
  // (MQTT_USERNAME/MQTT_PASSWORD/MQTT_ALLOW_ANON from the environment block above).
  if (infra.id === 'mosquitto') {
    lines.push('    command:')
    lines.push('      - sh')
    lines.push('      - -c')
    lines.push('      - |')
    // rm -f: mosquitto_passwd -c refuses an existing file on restart (2.1+).
    // chown: mosquitto drops privileges to the mosquitto user BEFORE reading
    // the password file (2.0.22+/2.1 image rebuilds), so a root-owned 0600
    // pwfile crash-loops the broker (mirrors jarvis-installer#16).
    lines.push('        rm -f /tmp/pwfile')
    lines.push('        mosquitto_passwd -b -c /tmp/pwfile "$$MQTT_USERNAME" "$$MQTT_PASSWORD"')
    lines.push('        chown mosquitto:mosquitto /tmp/pwfile')
    lines.push('        {')
    lines.push('          echo "listener 1884"')
    lines.push('          echo "protocol mqtt"')
    lines.push('          echo "listener 9001"')
    lines.push('          echo "protocol websockets"')
    lines.push('          echo "allow_anonymous $$MQTT_ALLOW_ANON"')
    lines.push('          echo "password_file /tmp/pwfile"')
    lines.push('          echo "persistence true"')
    lines.push('          echo "persistence_location /mosquitto/data/"')
    lines.push('        } > /tmp/mosquitto.conf')
    lines.push('        exec mosquitto -c /tmp/mosquitto.conf')
  }

  // Postgres needs healthcheck and init-db mount
  if (infra.id === 'postgres') {
    lines.push('    healthcheck:')
    lines.push('      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-jarvis}"]')
    lines.push('      interval: 10s')
    lines.push('      timeout: 5s')
    lines.push('      retries: 5')
    lines.push('    volumes:')
    for (const vol of infra.volumes) {
      lines.push(`      - ${vol}`)
    }
    lines.push('      - ${INIT_DB_PATH:-./init-db.sh}:/docker-entrypoint-initdb.d/init-db.sh')
  } else if (infra.volumes.length > 0) {
    lines.push('    volumes:')
    for (const vol of infra.volumes) {
      lines.push(`      - ${vol}`)
    }
  }

  lines.push('    networks:')
  lines.push('      - jarvis')
  lines.push('    restart: unless-stopped')

  return lines
}

function getServiceImage(
  service: ServiceDefinition,
  state: WizardState,
  digests?: ImageDigestMap,
): string {
  const raw = service.ghcrImage ?? service.image

  // Third-party images (e.g. go2rtc) keep their original tag
  if (!raw.startsWith(FIRST_PARTY_PREFIX)) return raw
  const baseImage = raw.includes(':') ? raw.slice(0, raw.lastIndexOf(':')) : raw

  // Variant suffix: whisper's explicit backend selection (cpu default), else the
  // LLM gpu variant. Both are independent of each other.
  let suffix = ''
  if (service.id === 'jarvis-whisper-api') {
    suffix = WHISPER_BACKEND_SUFFIX[state.whisperBackend ?? 'cpu'] ?? ''
  } else if (shouldUseGpuVariant(service, state.hardware?.gpuType)) {
    const variantSuffix: Record<string, string> = {
      nvidia: '-cuda',
      amd: '-vulkan',
      'amd-rocm': '-rocm',
      none: '-cpu',
    }
    suffix = variantSuffix[state.hardware!.gpuType] ?? ''
  }

  const track = state.releaseTrack === 'dev' ? 'dev' : 'latest'
  return pinnedOrTaggedImage(baseImage, track, suffix, digests, state.pinImages ?? false)
}

/**
 * Emit GPU runtime config. `deviceIds` (nvidia only) pins the reservation to a
 * single GPU via `device_ids: ['<expr>']` — pass a compose interpolation like
 * `${WHISPER_GPU_DEVICE:-0}` so operators can re-pin from .env. Omit it to
 * reserve every GPU (`count: all`). Pinning matters on multi-GPU hosts: with
 * `count: all` the CUDA runtime layer-splits models across cards, and the
 * cross-GPU sync + contention costs real latency (prod 2026-08-15: both llama
 * sidecars were split across both 3090s).
 */
function pushGpuDevices(lines: string[], gpuType: string, deviceIds?: string): void {
  if (gpuType === 'nvidia') {
    lines.push('    ipc: host')
    lines.push('    shm_size: "8gb"')
    lines.push('    deploy:')
    lines.push('      resources:')
    lines.push('        reservations:')
    lines.push('          devices:')
    lines.push('            - driver: nvidia')
    if (deviceIds) {
      lines.push(`              device_ids: ['${deviceIds}']`)
    } else {
      lines.push('              count: all')
    }
    lines.push('              capabilities: [gpu]')
  } else if (gpuType === 'amd' || gpuType === 'amd-rocm') {
    lines.push('    devices:')
    lines.push('      - /dev/dri:/dev/dri')
    lines.push('      - /dev/kfd:/dev/kfd')
    lines.push('    ipc: host')
    lines.push('    shm_size: "8gb"')
    lines.push('    group_add:')
    lines.push('      - video')
    lines.push('      - render')
  }
}

function pushGpuConfig(
  lines: string[],
  service: ServiceDefinition,
  state: WizardState,
): void {
  // TTS: device passthrough follows the EXPLICIT ttsBackend selection (cpu
  // default). No image variant — the stock image's torch is CUDA-capable —
  // so this only emits a device reservation, pinned to a SINGLE gpu
  // (TTS_GPU_DEVICE, default 0). `count: all` invites OOM on hosts whose
  // GPU0 is already full of LLM+whisper (prod 2026-07-05: kokoro warmup
  // OOM'd next to a 20GB LLM until pinned to GPU1). Checked before the
  // service.gpu gate because jarvis-tts is not a gpu-flagged service.
  if (service.id === 'jarvis-tts') {
    if ((state.ttsBackend ?? 'cpu') === 'cuda') {
      lines.push('    deploy:')
      lines.push('      resources:')
      lines.push('        reservations:')
      lines.push('          devices:')
      lines.push('            - driver: nvidia')
      lines.push("              device_ids: ['${TTS_GPU_DEVICE:-0}']")
      lines.push('              capabilities: [gpu]')
    }
    return
  }

  if (!service.gpu) return

  // Whisper: device passthrough follows the EXPLICIT whisperBackend selection
  // (cpu default), independent of the auto-detected LLM gpuType. cpu -> nothing.
  // Pinned to ONE gpu (WHISPER_GPU_DEVICE, default 0) — shares GPU0 with the
  // background llama sidecar on prod, away from live voice on GPU1.
  if (service.id === 'jarvis-whisper-api') {
    const wb = state.whisperBackend ?? 'cpu'
    if (wb !== 'cpu') {
      pushGpuDevices(lines, WHISPER_BACKEND_GPU[wb] ?? 'none', '${WHISPER_GPU_DEVICE:-0}')
    }
    return
  }

  const detected = state.hardware?.gpuType
  // cpuFallback services skip GPU runtime config when the host either has no
  // GPU or has a GPU type we don't ship a variant for — they degrade to the
  // CPU image gracefully.
  if (service.cpuFallback) {
    if (!detected || !CPU_FALLBACK_GPU_VARIANTS.has(detected)) return
  }
  // GPU-required services (no cpuFallback) MUST get GPU passthrough or the
  // container won't boot. If detection failed (state-reconstructor couldn't
  // probe the host), fall back to nvidia — the most common case and matches
  // legacy installs whose original wizard hardware selection wasn't persisted.
  const gpuType = detected ?? 'nvidia'
  if (gpuType === 'nvidia' || gpuType === 'amd' || gpuType === 'amd-rocm') {
    pushGpuDevices(lines, gpuType)
  } else {
    lines.push('    ipc: host')
  }
}

// Pinned llama.cpp build for the model sidecars. `:server-cuda` is a FLOATING tag:
// a `docker compose pull` silently swaps the inference engine, and prod & dev had
// already drifted onto different builds (same failure shape as the whisper.cpp
// unpinned-build incident). Third-party images bypass the digest-pin mechanism
// (getExportImage / PIN_IMAGES), so pin it here explicitly — always, regardless of
// PIN_IMAGES. Frozen 2026-08-19 to prod's live, known-good build; bump this digest
// deliberately after testing a new llama.cpp server-cuda build.
const LLAMA_CPP_IMAGE =
  'ghcr.io/ggml-org/llama.cpp@sha256:4d27e4014eb4baec84911d97112a73d6d47885341bf13c4abbeed70b875eed05'

/**
 * Standalone llama.cpp `llama-server` sidecar that serves the LIVE voice model
 * over REST (the proxy routes model.live.backend=REST → http://llama-server:8080).
 *
 * Emitted as a FIRST-CLASS compose service — NOT a registry `services[]` entry —
 * because that list also drives DB creation + app-cred registration + a python
 * healthcheck, none of which a raw third-party llama.cpp binary should get. This
 * is the fix for the docker-compose.override.yml footgun: a regen can no longer
 * silently drop the live-model sidecar (see state-reconstructor for the read-back).
 *
 * The command is parametrized by LIVE_MODEL_* env vars so switching the live model
 * is a `.env` write + `up -d llama-server`, never a YAML edit. -ctxcp/-cms preserve
 * prod's exact command for a zero-gap migration. No healthcheck (the image has no
 * curl/python) and callers must NOT add depends_on: {service_healthy} — a hard dep
 * would cascade-restart the proxy every time Phase 2 recreates just this container.
 * NVIDIA/Linux only (server-cuda image); callers gate on platform !== 'darwin'.
 */
function generateLlamaServerBlock(): string[] {
  const lines: string[] = []
  lines.push('  llama-server:')
  lines.push('    container_name: llama-server')
  lines.push(`    image: ${LLAMA_CPP_IMAGE}`)
  lines.push('    ports:')
  lines.push('      - "${LLAMA_SERVER_PORT:-7799}:8080"')
  lines.push('    volumes:')
  lines.push('      - ${MODELS_DIR:-./.models}:/models:ro')
  lines.push('    command:')
  lines.push('      - "-m"')
  lines.push('      - "/models/${LIVE_MODEL_FILE}"')
  lines.push('      - "--chat-template"')
  lines.push('      - "${LIVE_MODEL_CHAT_TEMPLATE:-chatml}"')
  lines.push('      - "-ngl"')
  lines.push('      - "${LIVE_MODEL_NGL:-99}"')
  lines.push('      - "-c"')
  // 24576 (not 32768): the live model must fit a SINGLE card once pinned —
  // max observed prod prompt is 16.6k tokens, so 24k leaves headroom without
  // spilling KV cache past one 3090's VRAM.
  lines.push('      - "${LIVE_MODEL_CTX:-24576}"')
  lines.push('      - "-ctxcp"')
  lines.push('      - "${LIVE_MODEL_CTXCP:-32}"')
  lines.push('      - "-cms"')
  lines.push('      - "${LIVE_MODEL_CMS:-256}"')
  lines.push('      - "--host"')
  lines.push('      - "0.0.0.0"')
  lines.push('      - "--port"')
  lines.push('      - "8080"')
  // NVIDIA reservation + ipc/shm (server-cuda needs a GPU). Pinned to ONE gpu
  // (LIVE_MODEL_GPU_DEVICE, default 1): `count: all` let CUDA layer-split the
  // model across both cards → cross-GPU sync + contention on every live-voice
  // token (prod 2026-08-15). Live shares GPU1 with kokoro TTS, away from
  // whisper + the background sidecar on GPU0.
  pushGpuDevices(lines, 'nvidia', '${LIVE_MODEL_GPU_DEVICE:-1}')
  lines.push('    networks:')
  lines.push('      - jarvis')
  lines.push('    restart: unless-stopped')
  return lines
}

/**
 * Background-model llama.cpp sidecar (`llama-server-bg`) — serves the proxy's
 * BACKGROUND slot (model.background.backend=REST → http://llama-server-bg:8080).
 *
 * Differences from the live block, all deliberate:
 * - `--jinja` instead of `--chat-template chatml`: reasoning models (Qwen3.8+)
 *   need their EMBEDDED chat template rendered — it carries the reasoning-effort
 *   default and the per-request `enable_thinking` kwarg the proxy uses to turn
 *   thinking off for jobs like memory extraction. A chatml override silently
 *   discards all of that.
 * - `-np` (parallel slots): per-slot context is `-c` divided by `-np`; the
 *   default 32768/2 gives two 16k slots so a long thinking job cannot
 *   head-of-line-block a second background request.
 * - No -ctxcp/-cms: context checkpointing is a live-voice latency optimization.
 * Same no-healthcheck / no-depends_on rules as generateLlamaServerBlock.
 */
function generateLlamaServerBgBlock(): string[] {
  const lines: string[] = []
  lines.push('  llama-server-bg:')
  lines.push('    container_name: llama-server-bg')
  lines.push(`    image: ${LLAMA_CPP_IMAGE}`)
  lines.push('    ports:')
  lines.push('      - "${LLAMA_SERVER_BG_PORT:-7798}:8080"')
  lines.push('    volumes:')
  lines.push('      - ${MODELS_DIR:-./.models}:/models:ro')
  lines.push('    command:')
  lines.push('      - "-m"')
  lines.push('      - "/models/${BG_MODEL_FILE}"')
  lines.push('      - "--jinja"')
  lines.push('      - "-ngl"')
  lines.push('      - "${BG_MODEL_NGL:-99}"')
  lines.push('      - "-c"')
  lines.push('      - "${BG_MODEL_CTX:-32768}"')
  lines.push('      - "-np"')
  lines.push('      - "${BG_MODEL_NP:-2}"')
  lines.push('      - "--host"')
  lines.push('      - "0.0.0.0"')
  lines.push('      - "--port"')
  lines.push('      - "8080"')
  // NVIDIA reservation + ipc/shm (server-cuda needs a GPU). Pinned to ONE gpu
  // (BG_MODEL_GPU_DEVICE, default 0) — background work shares GPU0 with
  // whisper, keeping GPU1 free for live voice (see generateLlamaServerBlock).
  pushGpuDevices(lines, 'nvidia', '${BG_MODEL_GPU_DEVICE:-0}')
  lines.push('    networks:')
  lines.push('      - jarvis')
  lines.push('    restart: unless-stopped')
  return lines
}

function generateServiceBlock(
  service: ServiceDefinition,
  state: WizardState,
  registry: ServiceRegistry,
  digests?: ImageDigestMap,
): string[] {
  const lines: string[] = []
  const portVar = serviceIdToPortVar(service.id)
  // jarvis-admin's containerized backend serves the SPA + API + /health on
  // PORT ?? 7711. The registry's 7710 is only the local "already-installed"
  // redirect target (startRedirectServer), unused in a fresh container. Forcing
  // the compose onto 7710 leaves 7711 dead — so the install-e2e harness's
  // :7711/health probe (and real admin access) miss it. Mirror the installer:
  // serve + publish + health-check admin on 7711.
  const effectivePort = service.id === 'jarvis-admin' ? 7711 : service.port
  const hostPort = state.portOverrides[service.id] ?? effectivePort
  const image = getServiceImage(service, state, digests)

  lines.push(`  ${service.id}:`)
  lines.push(`    image: ${image}`)
  lines.push(`    container_name: ${service.id}`)

  // Ports — containerPort is the port the service listens on inside the container
  // (may differ from the external port when the Dockerfile hardcodes a port)
  const containerPort = service.containerPort ?? effectivePort
  lines.push('    ports:')
  // JARVIS is a private local stack. Keep privileged HTTP APIs on loopback by
  // default; operators who deliberately deploy a trusted LAN gateway may opt
  // out with JARVIS_SERVICE_BIND_HOST=0.0.0.0 and must provide their own edge
  // authentication/TLS. MQTT is infrastructure and is emitted separately.
  lines.push(`      - "\${JARVIS_SERVICE_BIND_HOST:-127.0.0.1}:\${${portVar}:-${hostPort}}:${containerPort}"`)

  // Environment
  lines.push('    environment:')
  // Prod deployment: opt every service into strict boot-time secret enforcement
  // (jarvis-auth's guard is warn-only unless JARVIS_ENV=production). Safe because
  // the generator writes strong secrets for every SECRET_KEY.
  lines.push('      JARVIS_ENV: "production"')
  // Discovery URL style: dockerized makes config-service rewrite localhost-
  // registered entries (e.g. the MQTT broker) → host.docker.internal, reachable
  // via the extra_hosts host-gateway + published port. Only localhost entries are
  // rewritten; container-name entries stay on the bridge. Lets one broker entry
  // (localhost) resolve for both in-Docker services and remote Pi nodes.
  lines.push('      JARVIS_CONFIG_URL_STYLE: "dockerized"')
  // Set port env vars so the service listens on the expected port inside the container.
  // Different services use different env var names for their port.
  const portVarMap: Record<string, string[]> = {
    'jarvis-tts': ['TTS_PORT'],
    'jarvis-logs': ['LOG_SERVER_PORT'],
    'jarvis-notifications': ['NOTIFICATIONS_PORT'],
  }
  const portVarNames = portVarMap[service.id] ?? ['PORT']
  for (const pv of portVarNames) {
    lines.push(`      ${pv}: "${effectivePort}"`)
  }
  if (service.database) {
    const driver = service.dbDriverPrefix ?? 'postgresql://'
    lines.push(
      `      DATABASE_URL: ${driver}\${DB_USER:-jarvis}:\${POSTGRES_PASSWORD}@postgres:5432/${service.database}`,
    )
    lines.push(
      `      MIGRATIONS_DATABASE_URL: ${driver}\${DB_USER:-jarvis}:\${POSTGRES_PASSWORD}@postgres:5432/${service.database}`,
    )
  }
  const alreadyWritten = new Set(portVarNames)
  for (const env of service.envVars) {
    // Skip vars already written (DATABASE_URL from database field, port vars from portVarMap)
    if (env.name === 'DATABASE_URL' || env.name === 'MIGRATIONS_DATABASE_URL') continue
    if (alreadyWritten.has(env.name)) continue
    if (env.secretRef) {
      lines.push(`      ${env.name}: \${${env.secretRef}}`)
    } else if (env.default) {
      lines.push(`      ${env.name}: ${env.default}`)
    }
  }

  // Whisper model path override
  const isWhisper = service.id === 'jarvis-whisper-api'
  const whisperPath = state.whisperModelPath || `/whisper-models/ggml-${state.whisperModel}.bin`
  const defaultWhisperPath = '/whisper-models/ggml-base.en.bin'
  if (isWhisper && whisperPath !== defaultWhisperPath) {
    lines.push(`      WHISPER_MODEL: ${whisperPath}`)
  }

  // TTS → kokoro device: env_fallback for a fresh install whose settings DB
  // has no tts.kokoro_device row yet (a DB value wins once set). Backend
  // values ('cpu'/'cuda') are valid kokoro device names, so TTS_BACKEND is
  // reused directly.
  if (service.id === 'jarvis-tts' && (state.ttsBackend ?? 'cpu') === 'cuda') {
    lines.push('      TTS_KOKORO_DEVICE: ${TTS_BACKEND:-cpu}')
  }

  // LLM interface seed for command-center
  if (service.id === 'jarvis-command-center' && state.llmInterface) {
    lines.push(`      LLM_INTERFACE_SEED: ${state.llmInterface}`)
  }

  // Inter-service URLs for remote-llm mode
  if (service.id === 'jarvis-command-center' && state.deploymentMode === 'remote-llm') {
    if (state.remoteLlmUrl) {
      lines.push(`      JARVIS_LLM_PROXY_URL: ${state.remoteLlmUrl}`)
    }
    if (state.remoteWhisperUrl) {
      lines.push(`      JARVIS_WHISPER_URL: ${state.remoteWhisperUrl}`)
    }
  }

  // CC → go2rtc: inject URL when camera streaming is enabled
  if (service.id === 'jarvis-command-center' && state.enabledModules.includes('go2rtc')) {
    lines.push(`      GO2RTC_URL: http://go2rtc:${state.portOverrides['go2rtc'] ?? 1984}`)
  }

  // CC → relay: inject URL when relay is enabled
  if (service.id === 'jarvis-command-center' && state.relayEnabled) {
    lines.push('      JARVIS_RELAY_URL: ${JARVIS_RELAY_URL:-}')
  }

  // Notifications → relay: inject URL + household JWT when relay is enabled.
  // The env-file name is JARVIS_RELAY_URL/JARVIS_RELAY_HOUSEHOLD_JWT (namespaced);
  // the notifications Python code reads them as RELAY_URL/RELAY_HOUSEHOLD_JWT.
  // Without both, _deliver_via_relay short-circuits and push silently no-ops.
  if (service.id === 'jarvis-notifications' && state.relayEnabled) {
    lines.push('      RELAY_URL: ${JARVIS_RELAY_URL:-}')
    lines.push('      RELAY_HOUSEHOLD_JWT: ${JARVIS_RELAY_HOUSEHOLD_JWT:-}')
  }

  // Admin → host platform: env-generator writes HOST_OS to .env at install
  // time; admin reads it via getHostPlatform() to know whether to expose the
  // native-services UI (Docker masks the real platform from process.platform).
  if (service.id === 'jarvis-admin') {
    lines.push('      HOST_OS: ${HOST_OS:-linux}')
  }

  // go2rtc: standalone streaming gateway, no Jarvis auth/config needed
  if (service.id === 'go2rtc') {
    // No app-to-app auth, no extra environment — skip to volumes/network
    lines.push('    volumes:')
    lines.push('      - ${GO2RTC_CONFIG_PATH:-./go2rtc.yaml}:/config/go2rtc.yaml')
    lines.push('    networks:')
    lines.push('      - jarvis')
    lines.push('    restart: unless-stopped')
    return lines
  }

  // App-to-app auth placeholders (filled after registration)
  lines.push('      JARVIS_APP_ID: ${JARVIS_APP_ID_' + service.id.replace(/^jarvis-/, '').replace(/-/g, '_').toUpperCase() + ':-}')
  lines.push('      JARVIS_APP_KEY: ${JARVIS_APP_KEY_' + service.id.replace(/^jarvis-/, '').replace(/-/g, '_').toUpperCase() + ':-}')

  // Auth URL for all services that depend on jarvis-auth.
  // The ./jarvis CLI injects this into every service's .env (line 599).
  // Needed because auth-client validates before config-client finishes discovery.
  const alreadyHasAuthUrl = service.envVars.some((e) => e.name === 'JARVIS_AUTH_BASE_URL')
  if (service.dependsOn.includes('jarvis-auth') && !alreadyHasAuthUrl) {
    lines.push('      JARVIS_AUTH_BASE_URL: http://host.docker.internal:${AUTH_PORT:-7701}')
  }

  // Command-center URL for services that call CC directly (e.g. jarvis-phone-gateway
  // fetching the call session). Same rationale + name convention as JARVIS_AUTH_BASE_URL;
  // without it the gateway defaulted to localhost and dropped every dial job
  // ("session fetch failed") — prod 2026-08-07.
  const alreadyHasCcUrl = service.envVars.some((e) => e.name === 'JARVIS_COMMAND_CENTER_BASE_URL')
  if (service.dependsOn.includes('jarvis-command-center') && !alreadyHasCcUrl) {
    lines.push('      JARVIS_COMMAND_CENTER_BASE_URL: http://host.docker.internal:${COMMAND_CENTER_PORT:-7703}')
  }

  // LLM proxy needs model service config and backend env vars
  if (service.id === 'jarvis-llm-proxy-api') {
    lines.push('      MODEL_SERVICE_URL: http://localhost:7705')
    lines.push('      MODEL_SERVICE_PORT: "7705"')
    lines.push('      VLLM_WORKER_MULTIPROC_METHOD: spawn')
    lines.push('      JARVIS_MODEL_BACKEND: ${JARVIS_MODEL_BACKEND:-GGUF}')
    lines.push('      JARVIS_MODEL_NAME: ${JARVIS_MODEL_NAME:-}')
    lines.push('      JARVIS_MODEL_CHAT_FORMAT: ${JARVIS_MODEL_CHAT_FORMAT:-chatml}')
    lines.push('      JARVIS_MODEL_CONTEXT_WINDOW: ${JARVIS_MODEL_CONTEXT_WINDOW:-32768}')
    lines.push('      HUGGINGFACE_HUB_TOKEN: ${HUGGINGFACE_HUB_TOKEN:-}')
    lines.push('      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379/0')
    // Internal auth to the model service (:7705). The model service 503s ALL
    // inference when this is unset (while /health stays green), so it must be
    // present on both the API and the worker.
    lines.push('      MODEL_SERVICE_TOKEN: ${MODEL_SERVICE_TOKEN}')
    // gfx1201 (RDNA4) HIP flash-attn kernel faults during inference; ship it OFF
    // on AMD (matches the installer). Discrete-GPU selection is handled in-image.
    if (state.hardware?.gpuType === 'amd' || state.hardware?.gpuType === 'amd-rocm') {
      lines.push('      JARVIS_FLASH_ATTN: "false"')
    }
  }

  // Settings server needs the auth secret for JWT validation
  if (service.id === 'jarvis-settings-server') {
    lines.push('      JARVIS_AUTH_SECRET_KEY: ${AUTH_SECRET_KEY}')
    lines.push('      JARVIS_AUTH_ALGORITHM: HS256')
  }

  // Dependencies
  if (service.dependsOn.length > 0) {
    lines.push('    depends_on:')
    for (const dep of service.dependsOn) {
      const isInfra = registry.infrastructure.some((i) => i.id === dep)
      if (isInfra && dep === 'postgres') {
        lines.push(`      ${dep}:`)
        lines.push('        condition: service_healthy')
      } else {
        lines.push(`      ${dep}:`)
        lines.push('        condition: service_started')
      }
    }
  }

  // Services with Alembic migrations (registry `migrate: true`): wrap the image
  // CMD in an entrypoint that runs `alembic upgrade head` first, then execs the
  // original command via "$@". This keeps migrations consistent across every
  // migrate-set service without duplicating per-service serve commands. None of
  // these images set ENTRYPOINT (all use CMD), so overriding entrypoint is safe.
  if (service.migrate) {
    lines.push('    entrypoint:')
    lines.push('      - /bin/sh')
    lines.push('      - -c')
    lines.push('      - python -m alembic upgrade head && exec "$@"')
    lines.push('      - jarvis-migrate')
  }

  // Overriding `entrypoint` (above) CLEARS the image's CMD, so the migrate
  // wrapper's `exec "$@"` has nothing to run unless we supply a command. llm-proxy
  // uses its image's supervised launcher (scripts/serve.sh): API in the foreground
  // plus the model service respawned with backoff — the old raw dual-uvicorn
  // `model_service & exec main` left the model service unsupervised, so a native
  // crash (llama.cpp) meant no respawn and the API 503'd forever (2026-07-02
  // outage; roadmap #59). Every other migrate service serves app.main:app.
  // Without this, command-center/whisper/notifications exec "" and exit right
  // after migrating (restart-loop, no server) — the bug that 500'd the fleet.
  if (service.id === 'jarvis-llm-proxy-api') {
    lines.push('    command: ["bash", "scripts/serve.sh"]')
  } else if (service.id === 'jarvis-auth') {
    // jarvis-auth is the one migrate service whose app is NOT at top-level
    // `app.main` — its image packages it under `jarvis_auth.app.main`. Using the
    // generic `app.main:app` here crash-loops auth with `ModuleNotFoundError: No
    // module named 'app'`, so it never serves /health (the installer's
    // gen-export-compose already special-cases auth this same way).
    lines.push(`    command: ["uvicorn", "jarvis_auth.app.main:app", "--host", "0.0.0.0", "--port", "${containerPort}"]`)
  } else if (service.migrate) {
    lines.push(`    command: ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "${containerPort}"]`)
  }

  pushGpuConfig(lines, service, state)

  // Volumes
  const vols: string[] = []
  if (isWhisper) {
    // Same docker-out-of-docker pattern as MODELS_DIR — env-generator fills
    // WHISPER_MODELS_DIR with the absolute host path when admin runs in a
    // container. Native installs fall through to the relative default.
    vols.push('      - ${WHISPER_MODELS_DIR:-./whisper-models}:/whisper-models:ro')
  }
  // modelVolume: only LLM-style services that load weights from disk need this
  // bind. Generic GPU services (like whisper, which bakes its model into the image)
  // shouldn't get a stray .models directory mounted.
  if (service.modelVolume) {
    vols.push('      - ${MODELS_DIR:-./.models}:/app/.models')
  }
  if (service.volumes) {
    for (const vol of service.volumes) {
      vols.push(`      - ${vol}`)
    }
  }
  if (vols.length > 0) {
    lines.push('    volumes:')
    lines.push(...vols)
  }

  // extra_hosts for reaching host services (e.g., native llm-proxy on macOS)
  lines.push('    extra_hosts:')
  lines.push('      - "host.docker.internal:host-gateway"')

  // Healthcheck. Default to python urllib since most service images are
  // python:slim-based and don't ship curl — using curl made auth/config-service/
  // logs/notifications all report unhealthy despite the endpoint working.
  // Node-based first-party images have no python, so a python healthcheck
  // always fails with `exec: "python": executable file not found` and pins the
  // container "unhealthy" forever. jarvis-web (Next.js) and jarvis-admin
  // (Fastify) are Node — skip them here; each ships its own wget HEALTHCHECK in
  // its Dockerfile, which Docker uses when the compose omits one.
  if (!NODE_HEALTHCHECK_SERVICES.has(service.id)) {
    lines.push('    healthcheck:')
    lines.push(`      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:${containerPort}${service.healthCheck}')"]`)
    lines.push('      interval: 30s')
    lines.push('      timeout: 10s')
    lines.push('      retries: 3')
    // LLM proxy needs extra time for model loading
    if (service.id === 'jarvis-llm-proxy-api') {
      lines.push('      start_period: 120s')
    } else if (service.database) {
      lines.push('      start_period: 30s')
    }
  }

  lines.push('    networks:')
  lines.push('      - jarvis')
  lines.push('    restart: unless-stopped')

  return lines
}

function generateWorkerBlock(
  worker: WorkerDefinition,
  parent: ServiceDefinition,
  state: WizardState,
  registry: ServiceRegistry,
  digests?: ImageDigestMap,
): string[] {
  const lines: string[] = []
  const image = getServiceImage(parent, state, digests)
  const overrides = worker.envOverrides ?? {}
  const overrideKeys = new Set(Object.keys(overrides))

  lines.push(`  ${worker.id}:`)
  lines.push(`    image: ${image}`)
  lines.push(`    container_name: ${worker.id}`)

  lines.push('    environment:')
  lines.push('      JARVIS_ENV: "production"')

  if (parent.database) {
    const driver = parent.dbDriverPrefix ?? 'postgresql://'
    const dbUrl = `${driver}\${DB_USER:-jarvis}:\${POSTGRES_PASSWORD}@postgres:5432/${parent.database}`
    if (!overrideKeys.has('DATABASE_URL')) lines.push(`      DATABASE_URL: ${dbUrl}`)
    if (!overrideKeys.has('MIGRATIONS_DATABASE_URL')) {
      lines.push(`      MIGRATIONS_DATABASE_URL: ${dbUrl}`)
    }
  }

  for (const env of parent.envVars) {
    if (env.name === 'DATABASE_URL' || env.name === 'MIGRATIONS_DATABASE_URL') continue
    if (overrideKeys.has(env.name)) continue
    if (env.secretRef) {
      lines.push(`      ${env.name}: \${${env.secretRef}}`)
    } else if (env.default) {
      lines.push(`      ${env.name}: ${env.default}`)
    }
  }

  const appKeySuffix = parent.id.replace(/^jarvis-/, '').replace(/-/g, '_').toUpperCase()
  if (!overrideKeys.has('JARVIS_APP_ID')) {
    lines.push(`      JARVIS_APP_ID: \${JARVIS_APP_ID_${appKeySuffix}:-}`)
  }
  if (!overrideKeys.has('JARVIS_APP_KEY')) {
    lines.push(`      JARVIS_APP_KEY: \${JARVIS_APP_KEY_${appKeySuffix}:-}`)
  }

  const parentHasAuthUrl = parent.envVars.some((e) => e.name === 'JARVIS_AUTH_BASE_URL')
  if (
    parent.dependsOn.includes('jarvis-auth') &&
    !parentHasAuthUrl &&
    !overrideKeys.has('JARVIS_AUTH_BASE_URL')
  ) {
    lines.push('      JARVIS_AUTH_BASE_URL: http://host.docker.internal:${AUTH_PORT:-7701}')
  }

  const parentHasCcUrl = parent.envVars.some((e) => e.name === 'JARVIS_COMMAND_CENTER_BASE_URL')
  if (
    parent.dependsOn.includes('jarvis-command-center') &&
    !parentHasCcUrl &&
    !overrideKeys.has('JARVIS_COMMAND_CENTER_BASE_URL')
  ) {
    lines.push('      JARVIS_COMMAND_CENTER_BASE_URL: http://host.docker.internal:${COMMAND_CENTER_PORT:-7703}')
  }

  // Mirror llm-proxy backend env so the worker can resolve models + queue.
  // Override defaults (notably MODEL_SERVICE_URL) come from worker.envOverrides.
  if (parent.id === 'jarvis-llm-proxy-api') {
    const llmProxyEnv: Array<[string, string]> = [
      ['MODEL_SERVICE_URL', 'http://localhost:7705'],
      ['MODEL_SERVICE_PORT', '"7705"'],
      ['VLLM_WORKER_MULTIPROC_METHOD', 'spawn'],
      ['JARVIS_MODEL_BACKEND', '${JARVIS_MODEL_BACKEND:-GGUF}'],
      ['JARVIS_MODEL_NAME', '${JARVIS_MODEL_NAME:-}'],
      ['JARVIS_MODEL_CHAT_FORMAT', '${JARVIS_MODEL_CHAT_FORMAT:-chatml}'],
      ['JARVIS_MODEL_CONTEXT_WINDOW', '${JARVIS_MODEL_CONTEXT_WINDOW:-32768}'],
      ['HUGGINGFACE_HUB_TOKEN', '${HUGGINGFACE_HUB_TOKEN:-}'],
      ['REDIS_URL', 'redis://:${REDIS_PASSWORD}@redis:6379/0'],
      // The worker authenticates to the model service with the SAME token as the API.
      ['MODEL_SERVICE_TOKEN', '${MODEL_SERVICE_TOKEN}'],
    ]
    for (const [key, val] of llmProxyEnv) {
      if (!overrideKeys.has(key)) lines.push(`      ${key}: ${val}`)
    }
    // gfx1201 (RDNA4) HIP flash-attn kernel faults; ship it OFF on AMD (matches API + installer).
    if (
      (state.hardware?.gpuType === 'amd' || state.hardware?.gpuType === 'amd-rocm') &&
      !overrideKeys.has('JARVIS_FLASH_ATTN')
    ) {
      lines.push('      JARVIS_FLASH_ATTN: "false"')
    }
  }

  for (const [key, val] of Object.entries(overrides)) {
    lines.push(`      ${key}: ${val}`)
  }

  lines.push(`    command: ${worker.command}`)

  lines.push('    depends_on:')
  lines.push(`      ${parent.id}:`)
  lines.push('        condition: service_healthy')
  for (const dep of parent.dependsOn) {
    const isInfra = registry.infrastructure.some((i) => i.id === dep)
    if (!isInfra) continue
    lines.push(`      ${dep}:`)
    lines.push(`        condition: ${dep === 'postgres' ? 'service_healthy' : 'service_started'}`)
  }

  pushGpuConfig(lines, parent, state)

  const vols: string[] = []
  if (parent.modelVolume) {
    vols.push('      - ${MODELS_DIR:-./.models}:/app/.models')
  }
  if (parent.volumes) {
    for (const vol of parent.volumes) {
      vols.push(`      - ${vol}`)
    }
  }
  if (vols.length > 0) {
    lines.push('    volumes:')
    lines.push(...vols)
  }

  lines.push('    extra_hosts:')
  lines.push('      - "host.docker.internal:host-gateway"')

  lines.push('    networks:')
  lines.push('      - jarvis')
  lines.push('    restart: unless-stopped')

  return lines
}
