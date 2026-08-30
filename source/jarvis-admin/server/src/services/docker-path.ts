import { existsSync } from 'node:fs'

/**
 * Ensure Docker Desktop's `docker` CLI is resolvable via PATH on macOS.
 *
 * macOS GUI/launchd processes inherit a minimal PATH (/usr/bin:/bin:/usr/sbin:
 * /sbin) that excludes where Docker Desktop installs `docker` (/opt/homebrew/bin,
 * /usr/local/bin, or the app bundle). Every `execSync('docker …')` in the admin
 * then fails with "command not found" — which surfaces as a false "Docker not
 * found" in the install wizard even when Docker Desktop is running. Prepending
 * the standard locations makes docker resolve no matter how the admin was
 * launched (launchd, Finder, or a shell that already had them).
 *
 * Injectable (platform/exists/env) purely so it's testable without mocking
 * globals; callers invoke it with no args.
 */
export function ensureDockerOnPath(
  opts: {
    platform?: NodeJS.Platform
    exists?: (p: string) => boolean
    env?: NodeJS.ProcessEnv
  } = {},
): void {
  const platform = opts.platform ?? process.platform
  const exists = opts.exists ?? existsSync
  const env = opts.env ?? process.env
  if (platform !== 'darwin') return

  const candidates = [
    '/opt/homebrew/bin', // Apple Silicon Homebrew
    '/usr/local/bin', // Intel Homebrew + Docker Desktop's classic symlink
    '/Applications/Docker.app/Contents/Resources/bin', // Docker Desktop bundled CLI
  ]
  const current = (env.PATH ?? '').split(':').filter(Boolean)
  const toAdd = candidates.filter((p) => exists(p) && !current.includes(p))
  if (toAdd.length > 0) {
    env.PATH = [...toAdd, ...current].join(':')
  }
}
