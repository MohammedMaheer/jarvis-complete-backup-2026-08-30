import type { HostPlatform } from './host-platform.js'

/**
 * After a successful install, should the admin binary self-terminate?
 *
 * - Linux / other: YES. The generated compose brings up a *containerized*
 *   admin that binds the same port, so the throwaway native installer must
 *   `disableAutostart()` + `process.exit(0)` to free the port and hand off.
 * - macOS: NO. There is no admin container on macOS — a containerized admin
 *   can't manage the compose or reach the GPU through Docker Desktop, so
 *   `compose-generator` excludes it. This native binary IS the permanent
 *   admin; it must stay alive to serve the dashboard AND the native-services
 *   (llm-proxy / whisper / tts) install step that runs immediately after.
 *
 * Regression guard: v0.1.72→.73 moved admin to core + excluded its container
 * on macOS, but the completion path still self-terminated expecting a
 * container. The native admin killed itself right after the Docker install, so
 * the native-services step lost its backend ("all native pulls failed").
 */
export function shouldSelfTerminateAfterInstall(hostPlatform: HostPlatform): boolean {
  return hostPlatform !== 'darwin'
}

/**
 * On startup, when already installed, should the admin serve a lightweight
 * redirect to a containerized dashboard instead of building the full app?
 *
 * - Linux / other: YES. The container serves the real dashboard on the same
 *   port; this binary only redirects.
 * - macOS: NO. No container exists, so the native binary must serve the full
 *   app itself — the SPA renders the dashboard once `isInstalled()` is true.
 *   Redirecting would point at a port nothing listens on.
 */
export function shouldRedirectWhenInstalled(nodePlatform: NodeJS.Platform): boolean {
  return nodePlatform !== 'darwin'
}
