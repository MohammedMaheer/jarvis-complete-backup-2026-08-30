import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { requireSuperuser } from '../middleware/auth.js'
import { savePersistedConfig } from '../config.js'
import { checkForUpdate } from '../services/update-checker.js'

const UPGRADE_MARKER = join(homedir(), '.jarvis', 'upgrade-in-progress.json')

export interface UpgradeStatus {
  inProgress: boolean
  phase?: string
  version?: string
  startedAt?: string
  /** Set when the startup resume failed; `phase` is then "error". */
  error?: string
}

function getUpgradeStatus(): UpgradeStatus {
  if (!existsSync(UPGRADE_MARKER)) {
    return { inProgress: false }
  }
  try {
    const data = JSON.parse(readFileSync(UPGRADE_MARKER, 'utf-8')) as {
      version: string
      phase: string
      startedAt: string
      error?: string
    }
    // A failed resume leaves the marker behind on purpose (so the failure is
    // visible), but the upgrade is over — reporting inProgress would leave the
    // UI spinning forever on something that already stopped.
    return { inProgress: data.phase !== 'error', ...data }
  } catch {
    return { inProgress: false }
  }
}

export async function updateRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Read the box-level update opt-in.
   *
   * Unauthenticated, like `/check` — it's a single boolean about this box's own
   * configuration, and the SPA needs it before login to render the update card
   * honestly.
   */
  app.get('/settings', async (_request, reply) => {
    return reply.send({ allowUpdates: app.config.allowUpdates })
  })

  /**
   * Flip the box-level update opt-in (superuser only).
   *
   * This exists because the flag used to be reachable ONLY by hand-editing a
   * launchd plist (or compose .env) and restarting the service — which put the
   * documented update path out of reach of the non-technical self-hosters it was
   * written for.
   *
   * Persisted to ~/.jarvis/admin.json, which `loadConfig` already prefers over
   * the `JARVIS_ALLOW_UPDATES` env var, so it survives a restart. We also mutate
   * the live config so it takes effect immediately — otherwise the user would
   * flip the switch and nothing would happen until they restarted, which is the
   * very papercut we're removing.
   */
  app.post('/settings', { preHandler: requireSuperuser }, async (request, reply) => {
    const body = request.body as { allowUpdates?: unknown } | undefined
    const allowUpdates = body?.allowUpdates

    if (typeof allowUpdates !== 'boolean') {
      return reply.code(400).send({ error: 'allowUpdates must be a boolean' })
    }

    savePersistedConfig({ allowUpdates })
    app.config.allowUpdates = allowUpdates

    app.log.info({ allowUpdates }, 'update opt-in changed')
    return reply.send({ allowUpdates })
  })

  /** Check for available updates (no auth required — informational) */
  app.get('/check', async (_request, reply) => {
    const info = await checkForUpdate(false, app.config.allowUpdates)
    return reply.send({ ...info, updatesEnabled: app.config.allowUpdates })
  })

  /** Force a fresh update check */
  app.post('/check', async (_request, reply) => {
    const info = await checkForUpdate(true, app.config.allowUpdates)
    return reply.send({ ...info, updatesEnabled: app.config.allowUpdates })
  })

  /** Get current upgrade status (is an upgrade in progress?) */
  app.get('/status', async (_request, reply) => {
    return reply.send(getUpgradeStatus())
  })

  /** Apply an update — SSE endpoint that orchestrates the full upgrade */
  app.post('/apply', { preHandler: requireSuperuser }, async (_request, reply) => {
    if (!app.config.allowUpdates) {
      return reply.code(403).send({
        error:
          'Updates are disabled. Turn on "Check for updates" in the admin UI ' +
          '(or POST /api/update/settings {"allowUpdates":true}).',
      })
    }
    const info = await checkForUpdate(true, app.config.allowUpdates)
    if (!info.updateAvailable) {
      return reply.code(400).send({ error: 'No update available' })
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const emit = (data: Record<string, unknown>) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
      } catch {
        // Client disconnected
      }
    }

    try {
      // Import the upgrade orchestrator lazily (only when actually upgrading)
      const { runUpgrade } = await import('../services/upgrade/orchestrator.js')
      await runUpgrade(info.latestVersion, app, emit)
      emit({ done: true, code: 0 })
    } catch (err) {
      emit({ done: true, code: 1, error: err instanceof Error ? err.message : String(err) })
    }

    reply.raw.end()
  })
}
