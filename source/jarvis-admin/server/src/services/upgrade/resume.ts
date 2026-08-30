import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { savePersistedConfig } from '../../config.js'

const MARKER = (): string => join(homedir(), '.jarvis', 'upgrade-in-progress.json')

interface UpgradeMarker {
  version: string
  phase: string
  startedAt: string
  error?: string
}

function readMarker(): UpgradeMarker | null {
  const path = MARKER()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as UpgradeMarker
  } catch {
    // Corrupt marker: we can't know what it wanted. Drop it rather than block boot.
    unlinkSync(path)
    return null
  }
}

/**
 * Finish an upgrade that was interrupted by the admin restarting into its new
 * binary.
 *
 * The standalone upgrade path can't complete in one pass: `selfUpdate()` swaps
 * the binary and restarts the process, which kills the request (and the SSE
 * stream) mid-flight. It leaves `~/.jarvis/upgrade-in-progress.json` behind so
 * the NEW binary can pick up where the old one died — compose regen, image pull,
 * service restart, health verify.
 *
 * That hand-off was never wired: `resumeUpgrade()` existed, and nothing called
 * it. The result was that the Update button on native installs updated the admin
 * binary and *nothing else* — services stayed on their old images, the marker
 * sat at "binary-updated" forever, and `/api/update/status` reported an upgrade
 * permanently in progress.
 *
 * Called from startup, deliberately NOT awaited by the listen path: the upgrade
 * pulls images and restarts containers, which takes minutes, and the admin UI
 * has to be up during it (that's where the user watches `/api/update/status`).
 */
export async function resumeUpgradeIfPending(
  app: FastifyInstance,
  runningVersion: string,
): Promise<void> {
  const marker = readMarker()
  if (!marker) return

  // Already failed once. Don't retry on every boot — that would turn a broken
  // upgrade into a pull/restart loop. Leave it so the UI can surface the error.
  if (marker.phase === 'error') {
    app.log.warn(
      { marker },
      'previous upgrade failed; not retrying automatically (clear ~/.jarvis/upgrade-in-progress.json to reset)',
    )
    return
  }

  // The marker was written for a different version than the one now running, so
  // the binary swap did not land the way the updater thought (rollback, or a
  // hand-installed binary). Resuming would regenerate compose for a version we
  // aren't running — worse than doing nothing.
  if (marker.version !== runningVersion) {
    app.log.warn(
      { markerVersion: marker.version, runningVersion },
      'discarding stale upgrade marker (version mismatch)',
    )
    unlinkSync(MARKER())
    return
  }

  app.log.info({ version: marker.version }, 'resuming upgrade after binary restart')

  try {
    const { resumeUpgrade } = await import('./orchestrator.js')

    // Mirror each phase into the marker as it happens. /api/update/status reads
    // the marker, and it's the ONLY window the UI has into this stage — the SSE
    // stream died with the old process during the binary swap. Without this the
    // marker would sit at "binary-updated" for the entire resume and the client
    // could only report "something is happening" until it finished.
    let lastPhase = marker.phase
    await resumeUpgrade(app, marker, (data) => {
      app.log.info({ upgrade: data }, 'upgrade progress')
      const phase = typeof data.phase === 'string' ? data.phase : null
      if (phase && phase !== lastPhase) {
        lastPhase = phase
        writeFileSync(MARKER(), JSON.stringify({ ...marker, phase }))
      }
    })

    unlinkSync(MARKER())
    // Only now is the upgrade real: the binary AND the services are on the new
    // version. Recording it earlier would claim success for a stack that never
    // moved.
    savePersistedConfig({ installedVersion: marker.version })
    app.log.info({ version: marker.version }, 'upgrade complete')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Keep the marker so the failure is visible (and so we don't silently
    // pretend the upgrade finished), but mark it failed so the next boot doesn't
    // retry into the same wall.
    writeFileSync(MARKER(), JSON.stringify({ ...marker, phase: 'error', error: message }))
    app.log.error({ err: message, version: marker.version }, 'upgrade resume failed')
  }
}
