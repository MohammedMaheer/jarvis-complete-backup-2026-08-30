import { proxyRequest } from './proxy.js'

/**
 * LLM-proxy DB settings for the background model slot (llama-server-bg).
 *
 * Written by the reconcile flow right after `docker compose up` succeeds, so
 * enabling the sidecar on the Reconcile page is ONE action: compose gains the
 * llama-server-bg service AND the proxy's background slot is pointed at it.
 * All model.* keys are requires_reload on the proxy side — the caller must
 * restart the llm-proxy containers (the same apply mechanism /api/llm/configure
 * uses) for them to take effect.
 */

/** Settings written when the background sidecar is enabled. */
export function buildBackgroundSlotSettings(
  modelFile: string,
  ctxPerSlot: number,
): Record<string, string | number> {
  return {
    'model.background.backend': 'REST',
    // Must differ from model.live.name — identical backend+path makes the proxy
    // share one instance and the background slot would silently stay on the
    // live model.
    'model.background.name': `.models/${modelFile}`,
    'model.background.rest_url': 'http://llama-server-bg:8080',
    // Per-request context: the sidecar splits -c across -np parallel slots.
    'model.background.context_window': ctxPerSlot,
    // -1 = thinking unrestricted → reasoning models run at their template's
    // default effort. Jobs that must not think (memory extraction, situation
    // matching) send reasoning_budget: 0 per-job.
    'model.background.reasoning_budget': '-1',
    // A thinking background job can legitimately run past the 60s defaults;
    // 240s is the hard ceiling before a runaway job is killed.
    'model_service.timeout_seconds': 240,
    'rest.timeout_seconds': 240,
  }
}

/** Settings written when the background sidecar is disabled: clear the slot so
 * it falls back to sharing the live model (the proxy's default). The raised
 * timeouts are left in place — harmless without a thinking model. */
export function buildBackgroundSlotDisableSettings(): Record<string, string | number> {
  return {
    'model.background.backend': '',
    'model.background.name': '',
    'model.background.rest_url': '',
    'model.background.context_window': 0,
    'model.background.reasoning_budget': '',
  }
}

/** Per-slot context = BG_MODEL_CTX / BG_MODEL_NP (compose defaults 32768/2). */
export function computeBgCtxPerSlot(env: Record<string, string>): number {
  const ctx = parseInt(env.BG_MODEL_CTX ?? '32768', 10) || 32768
  const np = parseInt(env.BG_MODEL_NP ?? '2', 10) || 2
  return Math.floor(ctx / np)
}

export interface BgSlotWriteResult {
  ok: boolean
  /** Keys the proxy rejected (e.g. an older proxy image that doesn't declare
   * model.background.reasoning_budget yet) — reported, never fatal. */
  failedKeys: string[]
  error?: string
}

/**
 * Write the background-slot settings to the llm-proxy, one key at a time so a
 * single unknown key (older proxy image) degrades to a warning instead of
 * sinking the whole write.
 */
export async function writeBackgroundSlotSettings(
  llmProxyUrl: string,
  authorization: string,
  settings: Record<string, string | number>,
): Promise<BgSlotWriteResult> {
  const failedKeys: string[] = []
  for (const [key, value] of Object.entries(settings)) {
    try {
      const res = await proxyRequest({
        method: 'PUT',
        url: `${llmProxyUrl}/settings/`,
        headers: { Authorization: authorization },
        body: { settings: { [key]: value } },
        timeout: 10_000,
      })
      if (res.status !== 200) failedKeys.push(key)
    } catch {
      failedKeys.push(key)
    }
  }
  if (failedKeys.length === Object.keys(settings).length) {
    return { ok: false, failedKeys, error: 'no settings were accepted by the LLM proxy' }
  }
  return { ok: true, failedKeys }
}
