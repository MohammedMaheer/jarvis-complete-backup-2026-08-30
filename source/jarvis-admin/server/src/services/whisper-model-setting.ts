import { proxyRequest } from './proxy.js'

// The whisper MODEL is a runtime setting, NOT a compose concern. jarvis-whisper-api
// reads `whisper.model_path` from the settings DB (via jarvis-settings-client) and
// HOT-RELOADS the model on the next transcription when it changes — the compose
// `WHISPER_MODEL` env is only its fallback. So the reconcile "Model path" field
// reads/writes this setting through config-service's settings gateway, not the
// generated compose. A global model path lives at SYSTEM scope (no household/node/
// user), which is exactly what the gateway PUT/GET operate on.
const WHISPER_SERVICE = 'jarvis-whisper-api'
export const WHISPER_MODEL_PATH_KEY = 'whisper.model_path'

/**
 * Read the runtime whisper model path from the config-service settings gateway.
 *
 * The gateway has no per-key GET, so we fetch the aggregated settings for
 * jarvis-whisper-api and pluck the key. Returns null when the gateway is
 * unreachable, the service isn't registered, or the key has no value — callers
 * fall back to the compose-derived value / default so the options screen still loads.
 */
export async function getWhisperModelPath(
  configServiceUrl: string,
  authorization: string | undefined,
): Promise<string | null> {
  if (!configServiceUrl || !authorization) return null
  const res = await proxyRequest({
    method: 'GET',
    url: `${configServiceUrl}/v1/settings/?service=${WHISPER_SERVICE}`,
    headers: { Authorization: authorization },
    timeout: 10_000,
  })
  if (res.status < 200 || res.status >= 300) return null
  const data = res.data as
    | { services?: Array<{ settings?: Array<{ key: string; value: unknown }> }> }
    | null
  const settings = data?.services?.[0]?.settings ?? []
  const row = settings.find((s) => s.key === WHISPER_MODEL_PATH_KEY)
  return typeof row?.value === 'string' && row.value.length > 0 ? row.value : null
}

export interface SetWhisperModelResult {
  ok: boolean
  error?: string
  requiresReload?: boolean
}

/**
 * Write whisper.model_path to the settings gateway (SYSTEM scope). whisper-api
 * picks the new model up on the next transcription (hot reload).
 *
 * The gateway can report a downstream failure as a 2xx with `success:false`, so
 * we inspect the body, not just the HTTP status.
 */
export async function setWhisperModelPath(
  configServiceUrl: string,
  authorization: string | undefined,
  value: string,
): Promise<SetWhisperModelResult> {
  if (!configServiceUrl) return { ok: false, error: 'config-service URL not configured' }
  if (!authorization) return { ok: false, error: 'missing authorization' }
  const res = await proxyRequest({
    method: 'PUT',
    url: `${configServiceUrl}/v1/settings/${WHISPER_SERVICE}/${WHISPER_MODEL_PATH_KEY}`,
    headers: { Authorization: authorization },
    body: { value },
    timeout: 10_000,
  })
  if (res.status < 200 || res.status >= 300) {
    const d = res.data as { detail?: string; error?: string } | null
    return { ok: false, error: d?.error || d?.detail || `HTTP ${res.status}` }
  }
  const d = res.data as { success?: boolean; error?: string; requires_reload?: boolean } | null
  if (d && d.success === false) {
    return { ok: false, error: d.error || 'gateway reported failure', requiresReload: d.requires_reload }
  }
  return { ok: true, requiresReload: d?.requires_reload }
}
