import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseRegistry } from '../generators/service-registry.js'
import registryData from '../../data/service-registry.json' with { type: 'json' }
import { getComposePath } from '../compose-path.js'

export type Emit = (data: Record<string, unknown>) => void

export interface NativeUpdateResult {
  updated: string[]
  skipped: string[]
  failed: { id: string; error: string }[]
}

export interface NativeUpdateDeps {
  /** ~/.jarvis/native — where managed checkouts live. */
  nativeRoot: string
  /** JARVIS_ROOT, when the operator is running services from a dev tree. */
  devRoot: string | null
  /** Service IDs currently installed as LaunchAgents. */
  installedNativeIds: () => string[]
  /** Where a service's source actually lives (dev tree or managed checkout). */
  sourceDirFor: (id: string) => string
  /** True only for a checkout WE own under nativeRoot — never a dev tree. */
  isManagedCheckout: (dir: string) => boolean
  /** True when the checkout is on disk with a deploy script. */
  hasCheckout: (dir: string) => boolean
  run: (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<void>
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
}

/**
 * Bring native (non-Docker) services up to date.
 *
 * On macOS, whisper / tts / llm-proxy run as launchd agents out of git checkouts
 * under `~/.jarvis/native/<id>` rather than as containers. The platform upgrade
 * regenerates compose and pulls Docker images — and did nothing at all for these.
 * A native service therefore stayed pinned to whatever `main` happened to be on
 * the day it was installed, with a full wipe-and-reinstall as the only way to
 * move it.
 *
 * The update itself is small, because the run scripts already do the hard part:
 * they reinstall deps when `pyproject.toml` changes (sentinel-gated) and run
 * `alembic upgrade head` on every start. So moving the source and restarting the
 * agent is enough — deps and migrations self-heal.
 *
 *   git fetch --depth 1 origin HEAD   (shallow clone: `git pull` can't fast-forward)
 *   git reset --hard FETCH_HEAD
 *   bash deploy-launchd.sh            (idempotent: re-materializes plist + bootstraps)
 *
 * Two rules:
 *
 * 1. **Never touch a dev checkout.** If the source resolves into `JARVIS_ROOT`,
 *    it's the operator's actual working repo — `git reset --hard` there would
 *    destroy uncommitted work. Skip it and say so.
 * 2. **Per-service failures are non-fatal.** A native service that fails to
 *    update leaves the box on older-but-working code; taking the whole platform
 *    upgrade down over it (after the containers have already moved) would be
 *    worse. Report and continue.
 */
export async function updateNativeServices(
  deps: NativeUpdateDeps,
  emit: Emit,
): Promise<NativeUpdateResult> {
  const result: NativeUpdateResult = { updated: [], skipped: [], failed: [] }
  const ids = deps.installedNativeIds()

  if (ids.length === 0) return result

  for (const id of ids) {
    const dir = deps.sourceDirFor(id)

    if (!deps.isManagedCheckout(dir)) {
      // A dev tree (JARVIS_ROOT). Updating it would blow away the operator's
      // uncommitted work — refuse, loudly.
      deps.log.warn({ id, dir }, 'native service runs from a dev checkout — not updating it')
      emit({ phase: 'native', message: `Skipping ${id} (running from a dev checkout at ${dir})` })
      result.skipped.push(id)
      continue
    }

    if (!deps.hasCheckout(dir)) {
      deps.log.warn({ id, dir }, 'native service has no checkout on disk — skipping')
      emit({ phase: 'native', message: `Skipping ${id} (no checkout at ${dir})` })
      result.skipped.push(id)
      continue
    }

    try {
      emit({ phase: 'native', message: `Updating ${id}...` })

      // Shallow clone → fetch + reset, not pull.
      await deps.run('git', ['fetch', '--depth', '1', 'origin', 'HEAD'], dir)
      await deps.run('git', ['reset', '--hard', 'FETCH_HEAD'], dir)

      // Re-running the deploy script refreshes the plist (it may itself have
      // changed) and restarts the agent; the run script then reinstalls deps if
      // pyproject moved and applies migrations.
      await deps.run('bash', [join(dir, 'deploy-launchd.sh')], dir, {
        ...process.env,
        ENV_FILE_PATH: join(getComposePath(), '.env'),
      })

      emit({ phase: 'native', message: `${id} updated` })
      result.updated.push(id)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      deps.log.error({ id, err: error }, 'native service update failed')
      emit({ phase: 'native', message: `${id} failed to update: ${error}` })
      result.failed.push({ id, error })
    }
  }

  return result
}

// ── real-world wiring ────────────────────────────────────────────────────────

const NATIVE_ROOT = join(homedir(), '.jarvis', 'native')

/** Launchd label a service's deploy script installs (llm-proxy uses a legacy short name). */
function launchdLabel(serviceId: string): string {
  if (serviceId === 'jarvis-llm-proxy-api') return 'com.jarvis.llm-proxy'
  return `com.jarvis.${serviceId.replace(/^jarvis-/, '')}`
}

function defaultRun(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env })
    let stderr = ''
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`))
    })
  })
}

export function defaultNativeUpdateDeps(log: NativeUpdateDeps['log']): NativeUpdateDeps {
  const registry = parseRegistry(registryData)
  const devRoot = process.env.JARVIS_ROOT ?? null

  const sourceDirFor = (id: string): string => {
    if (devRoot && existsSync(join(devRoot, id, 'deploy-launchd.sh'))) return join(devRoot, id)
    return join(NATIVE_ROOT, id)
  }

  return {
    nativeRoot: NATIVE_ROOT,
    devRoot,
    // "Installed natively" = the service can run native AND its LaunchAgent
    // plist exists. Reading the plists reflects what's actually on the box,
    // rather than trusting a stale list in .env.
    installedNativeIds: () =>
      registry.services
        .filter((s) => s.nativeCapable)
        .map((s) => s.id)
        .filter((id) =>
          existsSync(join(homedir(), 'Library', 'LaunchAgents', `${launchdLabel(id)}.plist`)),
        ),
    sourceDirFor,
    isManagedCheckout: (dir: string) => dir.startsWith(NATIVE_ROOT),
    hasCheckout: (dir: string) => existsSync(join(dir, 'deploy-launchd.sh')),
    run: defaultRun,
    log,
  }
}
