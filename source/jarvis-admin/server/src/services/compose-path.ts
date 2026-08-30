import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Where the user's docker-compose.yml + .env + init-db.sh live.
 *
 * Native-binary deploys default to ~/.jarvis/compose. When admin runs inside
 * Docker, the container can't see the host's home directory, so the generated
 * compose mounts the host compose dir into the container and sets
 * JARVIS_COMPOSE_PATH to that mount point. Honor it whenever set.
 */
export function getComposePath(): string {
  const override = process.env.JARVIS_COMPOSE_PATH
  if (override && override.length > 0) return override
  return join(homedir(), '.jarvis', 'compose')
}
