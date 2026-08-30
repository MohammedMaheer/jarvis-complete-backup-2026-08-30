// Detect the HOST operating system, not the container's.
//
// `process.platform` reports the platform of the running process — useless when
// admin runs in a Linux container on a macOS host (always returns 'linux').
// We rely on three signals, in order:
//
//   1. HOST_OS env var — explicit override, set by the compose-generator on
//      Mac installs (env-generator writes HOST_OS=darwin to .env).
//   2. `docker info --format '{{.OperatingSystem}}'` — returns "Docker Desktop"
//      on Mac (and Windows; we treat Docker Desktop as Mac for now since
//      Jarvis only supports native services on macOS).
//   3. `process.platform` — final fallback for the bare-metal admin case
//      (e.g. install.sh's LaunchAgent before the wizard finishes).
//
// Cached after the first call so the docker-info shell-out doesn't happen on
// every request.
import { execSync } from 'node:child_process'

export type HostPlatform = 'darwin' | 'linux' | 'win32'

let cached: HostPlatform | null = null

export function getHostPlatform(): HostPlatform {
  if (cached) return cached
  cached = compute()
  return cached
}

/** For tests: forget the cache so the next call re-detects. */
export function resetHostPlatformCache(): void {
  cached = null
}

function compute(): HostPlatform {
  const fromEnv = process.env.HOST_OS?.trim().toLowerCase()
  if (fromEnv === 'darwin' || fromEnv === 'linux' || fromEnv === 'win32') {
    return fromEnv
  }

  // Ask the Docker daemon. We have its socket mounted in the container.
  try {
    const out = execSync('docker info --format "{{.OperatingSystem}}"', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    // Docker Desktop reports "Docker Desktop"; Linux distros report e.g.
    // "Ubuntu 22.04". We treat Docker Desktop as macOS — Windows hosts are
    // rare for Jarvis and the native-services feature is Mac-only anyway, so
    // a Windows user will just see the native-services page list nothing they
    // can act on.
    if (/docker desktop/i.test(out)) {
      return 'darwin'
    }
  } catch {
    // No docker / can't reach daemon — fall through.
  }

  return process.platform as HostPlatform
}
