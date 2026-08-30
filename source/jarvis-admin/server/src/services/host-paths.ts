import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import Docker from 'dockerode'

/**
 * When admin runs inside a docker container, relative bind mounts in the
 * generated docker-compose.yml resolve against the container's working dir
 * (e.g. /host/compose) rather than the host filesystem. The daemon receives
 * a bind request for a path that doesn't exist on the host and creates an
 * empty directory there instead — silently breaking model loading for
 * llm-proxy.
 *
 * Detect the absolute host path the user mounted in (typically
 * `${JARVIS_HOST_COMPOSE_DIR:-.}:/host/compose`) by inspecting our own container's
 * mounts via the docker socket. Returns null when not running in docker.
 */
export async function getHostComposePath(): Promise<string | null> {
  // Quick non-docker exit: container env has /.dockerenv as a marker.
  if (!existsSync('/.dockerenv')) return null

  const containerId = readSelfContainerId()
  if (!containerId) return null

  try {
    const docker = new Docker({ socketPath: '/var/run/docker.sock' })
    const info = await docker.getContainer(containerId).inspect()
    const mount = info.Mounts.find((m) => m.Destination === '/host/compose')
    return mount?.Source ?? null
  } catch {
    return null
  }
}

/**
 * Read the current container's ID from /proc/self/cgroup or /etc/hostname.
 * Docker sets the hostname to the (truncated) container ID by default; cgroup
 * has the full ID under /docker/<id>.
 */
function readSelfContainerId(): string | null {
  try {
    const cgroup = readFileSync('/proc/self/cgroup', 'utf-8')
    const match = cgroup.match(/\/docker[/-]([0-9a-f]{12,64})/)
    if (match?.[1]) return match[1]
  } catch {
    // Fall through to hostname fallback
  }
  try {
    const host = hostname().trim()
    if (/^[0-9a-f]{12}$/.test(host)) return host
  } catch {
    // No hostname either
  }
  return null
}
