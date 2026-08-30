import { existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { selfUpdate } from './self-updater.js'
import { upgradeCompose } from './compose-upgrader.js'

type Emit = (data: Record<string, unknown>) => void

function isRunningInDocker(): boolean {
  return existsSync('/.dockerenv')
}

/**
 * Run the full upgrade flow.
 *
 * Two modes:
 * - **Standalone binary**: download new binary, swap, restart, then resume
 *   with compose regeneration + service updates.
 * - **Docker container**: skip binary self-update (admin container is updated
 *   separately via `docker compose pull`). Go straight to compose regeneration,
 *   image pull, and service restart.
 */
export async function runUpgrade(
  targetVersion: string,
  app: FastifyInstance,
  emit: Emit,
): Promise<void> {
  // Phase 1: Preflight
  emit({ phase: 'preflight', message: 'Checking prerequisites...' })
  if (!app.docker) {
    throw new Error('Docker is not available')
  }

  if (isRunningInDocker()) {
    // Docker mode: skip binary self-update, run the service upgrade inline
    await runDockerUpgrade(targetVersion, app, emit)
  } else {
    // Standalone mode: download binary, swap, restart (resumes via marker)
    emit({ phase: 'download', message: `Downloading Jarvis v${targetVersion}...` })
    await selfUpdate(targetVersion, emit)
    // Phase 3 happens inside selfUpdate: atomic swap + restart marker + process restart
    // After restart, the new binary reads the marker and calls resumeUpgrade()
  }
}

/**
 * Docker-mode upgrade: regenerate compose, pull images, restart services.
 * Admin container itself is NOT updated here — user pulls it separately.
 */
async function runDockerUpgrade(
  targetVersion: string,
  app: FastifyInstance,
  emit: Emit,
): Promise<void> {
  // Regenerate compose + merge env
  emit({ phase: 'compose', message: 'Updating configuration...' })
  await upgradeCompose(app)

  // Pull new images
  emit({ phase: 'pull', message: 'Pulling updated images...' })
  const { pullImages, restartServices, verifyHealth } = await import('./service-updater.js')
  await pullImages(app, emit)

  // Restart services
  emit({ phase: 'restart', message: 'Restarting services...' })
  await restartServices(app, emit)

  // Update native (non-Docker) services. On macOS whisper/tts/llm-proxy run as
  // launchd agents from git checkouts, so `docker compose pull` does nothing for
  // them — without this they stay frozen at whatever `main` was on install day.
  // Best-effort: a native service that won't update leaves the box on
  // older-but-working code, which beats failing an upgrade whose containers have
  // already moved.
  await updateNativeServicesStep(app, emit)

  // Verify health
  emit({ phase: 'verify', message: 'Verifying health...' })
  await verifyHealth(app, emit)

  emit({ phase: 'done', message: `Upgrade to v${targetVersion} complete! To update admin itself: docker compose pull jarvis-admin && docker compose up -d --force-recreate jarvis-admin` })
}

/**
 * Resume upgrade after binary restart. Called from startup hook.
 */
export async function resumeUpgrade(
  app: FastifyInstance,
  marker: { version: string; phase: string; startedAt: string },
  emit: Emit,
): Promise<void> {
  const { version } = marker

  // Phase 4: Regenerate compose + merge env
  emit({ phase: 'compose', message: 'Updating configuration...' })
  await upgradeCompose(app)

  // Phase 5: Pull new images
  emit({ phase: 'pull', message: 'Pulling updated images...' })
  const { pullImages, restartServices, verifyHealth } = await import('./service-updater.js')
  await pullImages(app, emit)

  // Phase 6: Restart services
  emit({ phase: 'restart', message: 'Restarting services...' })
  await restartServices(app, emit)

  // Phase 7: Update native (non-Docker) services. THIS is the path that matters
  // for them: native services only exist on the standalone/macOS install, which
  // is exactly the flow that goes through the binary swap and lands here.
  await updateNativeServicesStep(app, emit)

  // Phase 8: Verify health
  emit({ phase: 'verify', message: 'Verifying health...' })
  await verifyHealth(app, emit)

  emit({ phase: 'done', message: `Upgrade to v${version} complete!` })
}

/**
 * Bring launchd-managed native services (macOS: whisper / tts / llm-proxy) up to
 * date. No-ops everywhere else — on Linux everything is a container.
 *
 * Best-effort by design: a native service that fails to update leaves the box on
 * older-but-working code, and failing the whole upgrade at this point — after the
 * containers have already been pulled and restarted — would be strictly worse.
 * Failures are surfaced in the stream and the logs.
 */
async function updateNativeServicesStep(app: FastifyInstance, emit: Emit): Promise<void> {
  try {
    const { updateNativeServices, defaultNativeUpdateDeps } = await import('./native-updater.js')
    const deps = defaultNativeUpdateDeps(app.log)

    if (deps.installedNativeIds().length === 0) return

    emit({ phase: 'native', message: 'Updating native services...' })
    const result = await updateNativeServices(deps, emit)

    app.log.info({ result }, 'native service update finished')
    if (result.failed.length > 0) {
      emit({
        phase: 'native',
        message: `Some native services did not update: ${result.failed.map((f) => f.id).join(', ')}`,
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    app.log.error({ err: message }, 'native service update step failed')
    emit({ phase: 'native', message: `Native service update failed: ${message}` })
  }
}
