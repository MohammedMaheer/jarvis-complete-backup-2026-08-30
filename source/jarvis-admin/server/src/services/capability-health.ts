import { AGENT_TOOL_REGISTRY } from './agent-tool-registry.js'

export type CapabilityHealthStatus =
  | 'READY'
  | 'ACTIVE'
  | 'DEGRADED'
  | 'OFFLINE'
  | 'DISABLED'
  | 'UNKNOWN'

export type ImplementationStatus =
  | 'IMPLEMENTED'
  | 'PARTIAL'
  | 'MOCKED'
  | 'BROKEN'
  | 'UNUSED'
  | 'DUPLICATED'
  | 'UNSAFE'
  | 'UNVERIFIED'

export interface CapabilityHealth {
  id: string
  label: string
  implementation: ImplementationStatus
  status: CapabilityHealthStatus
  required: boolean
  checkedAt: string
  latencyMs?: number
  endpoint?: string
  evidence: string
  recovery?: string
}

export interface CapabilityDiagnostics {
  schemaVersion: 1
  checkedAt: string
  overall: 'READY' | 'DEGRADED' | 'BLOCKED'
  locality: 'local-only'
  capabilities: CapabilityHealth[]
  summary: Record<CapabilityHealthStatus, number>
}

export interface CapabilityEndpoints {
  auth?: string
  config?: string
  commandCenter?: string
  llm?: string
  whisper?: string
  tts?: string
}

type Fetcher = typeof fetch

function healthUrl(base: string | undefined): string | undefined {
  if (!base) return undefined
  return `${base.replace(/\/$/, '')}/health`
}

async function probe(
  id: string,
  label: string,
  endpoint: string | undefined,
  required: boolean,
  fetcher: Fetcher,
): Promise<CapabilityHealth> {
  const checkedAt = new Date().toISOString()
  if (!endpoint) {
    return {
      id,
      label,
      implementation: 'IMPLEMENTED',
      status: 'OFFLINE',
      required,
      checkedAt,
      evidence: 'No local service endpoint is configured.',
      recovery: 'Restore the saved local service configuration and restart JARVIS.',
    }
  }

  const started = performance.now()
  try {
    const response = await fetcher(endpoint, { signal: AbortSignal.timeout(3_000) })
    const latencyMs = Math.round(performance.now() - started)
    if (!response.ok) {
      return {
        id,
        label,
        implementation: 'IMPLEMENTED',
        status: 'OFFLINE',
        required,
        checkedAt,
        latencyMs,
        endpoint,
        evidence: `Health probe returned HTTP ${response.status}.`,
        recovery: `Restart ${label} and inspect its local logs.`,
      }
    }
    return {
      id,
      label,
      implementation: 'IMPLEMENTED',
      status: 'READY',
      required,
      checkedAt,
      latencyMs,
      endpoint,
      evidence: `Local health endpoint responded with HTTP ${response.status}.`,
    }
  } catch (error) {
    return {
      id,
      label,
      implementation: 'IMPLEMENTED',
      status: 'OFFLINE',
      required,
      checkedAt,
      latencyMs: Math.round(performance.now() - started),
      endpoint,
      evidence: `Local health probe failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      recovery: `Restart ${label} and inspect its local logs.`,
    }
  }
}

function unverifiedCapability(id: string, label: string, evidence: string): CapabilityHealth {
  return {
    id,
    label,
    implementation: 'PARTIAL',
    status: 'UNKNOWN',
    required: false,
    checkedAt: new Date().toISOString(),
    evidence,
  }
}

export async function runCapabilityDiagnostics(
  endpoints: CapabilityEndpoints,
  fetcher: Fetcher = fetch,
): Promise<CapabilityDiagnostics> {
  const serviceChecks = await Promise.all([
    probe('auth', 'Authentication', healthUrl(endpoints.auth), true, fetcher),
    probe('config', 'Configuration service', healthUrl(endpoints.config), false, fetcher),
    probe('llm', 'Local Qwen inference', healthUrl(endpoints.llm), true, fetcher),
    probe('stt', 'Whisper speech recognition', healthUrl(endpoints.whisper), true, fetcher),
    probe('tts', 'Local speech synthesis', healthUrl(endpoints.tts), true, fetcher),
    probe('command_center', 'Command Center', healthUrl(endpoints.commandCenter), true, fetcher),
  ])

  const registryCount = Object.keys(AGENT_TOOL_REGISTRY).length
  const capabilities: CapabilityHealth[] = [
    ...serviceChecks,
    {
      id: 'tool_registry',
      label: 'Agent tool registry',
      implementation: 'IMPLEMENTED',
      status: registryCount > 0 ? 'READY' : 'OFFLINE',
      required: true,
      checkedAt: new Date().toISOString(),
      evidence: `${registryCount} schema-validated tools registered; execution remains permission gated.`,
    },
    unverifiedCapability(
      'pgvector',
      'Long-term pgvector memory',
      'Command Center reachability is measured, but this process cannot prove a database read/write without an authenticated memory smoke operation.',
    ),
    unverifiedCapability(
      'speaker_identity',
      'Speaker identity',
      'Whisper reachability is measured; enrollment and a live voiceprint match require operator speech and are not inferred from service health.',
    ),
    unverifiedCapability(
      'screen_context',
      'Screen context',
      'Available only through the Electron desktop bridge; the server has not observed a capture in this diagnostic run.',
    ),
    unverifiedCapability(
      'pc_control',
      'PC control',
      'Tools are registered, but no Windows action is reported as working until the desktop bridge returns verification evidence.',
    ),
    unverifiedCapability(
      'overlay',
      'Desktop overlay',
      'Renderer health, monitor placement, focus, and global shortcuts require an Electron runtime observation.',
    ),
  ]

  const statuses: CapabilityHealthStatus[] = ['READY', 'ACTIVE', 'DEGRADED', 'OFFLINE', 'DISABLED', 'UNKNOWN']
  const summary = Object.fromEntries(statuses.map((status) => [status, capabilities.filter((item) => item.status === status).length])) as Record<CapabilityHealthStatus, number>
  const requiredOffline = capabilities.some((item) => item.required && item.status === 'OFFLINE')
  const degraded = capabilities.some((item) => item.status === 'OFFLINE' || item.status === 'DEGRADED' || item.status === 'UNKNOWN')

  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    overall: requiredOffline ? 'BLOCKED' : degraded ? 'DEGRADED' : 'READY',
    locality: 'local-only',
    capabilities,
    summary,
  }
}

export function toSafeSmokeResult(diagnostics: CapabilityDiagnostics) {
  const required = diagnostics.capabilities.filter((item) => item.required)
  const failed = required.filter((item) => item.status !== 'READY' && item.status !== 'ACTIVE')
  const unverified = diagnostics.capabilities.filter((item) => item.status === 'UNKNOWN').map((item) => item.id)
  return {
    schemaVersion: 1 as const,
    pass: failed.length === 0,
    checkedAt: diagnostics.checkedAt,
    locality: diagnostics.locality,
    passed: required.filter((item) => !failed.includes(item)).map((item) => item.id),
    failed: failed.map((item) => ({ id: item.id, evidence: item.evidence, recovery: item.recovery })),
    unverified,
    note: 'This safe smoke test performs bounded local health probes and registry validation. It does not pretend to test live microphone input, speaker matching, screen capture, or PC actions.',
  }
}
