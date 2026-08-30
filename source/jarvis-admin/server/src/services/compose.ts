import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface ComposeService {
  enableModule(profile: string, composePath?: string): Promise<{ stdout: string; stderr: string }>
  disableModule(profile: string, composePath?: string): Promise<{ stdout: string; stderr: string }>
  /** Service names the given compose file defines (`docker compose config --services`). */
  listServices(composeFile: string): Promise<string[]>
  /**
   * Recreate one service's container so it re-reads env_file.
   * A plain `docker restart` NEVER reloads env — recreate is the only way
   * saved credentials reach the process (found live with the phone gateway:
   * signature_validation stayed false after restart, flipped on recreate).
   */
  recreateService(serviceId: string, composeFile: string): Promise<{ stdout: string; stderr: string }>
}

export function createComposeService(): ComposeService {
  return {
    async enableModule(
      profile: string,
      composePath?: string,
    ): Promise<{ stdout: string; stderr: string }> {
      const fileArg = composePath ? `-f ${composePath}` : ''
      const cmd = `docker compose ${fileArg} --profile ${profile} up -d`
      return execAsync(cmd, { timeout: 120_000 })
    },

    async disableModule(
      profile: string,
      composePath?: string,
    ): Promise<{ stdout: string; stderr: string }> {
      const fileArg = composePath ? `-f ${composePath}` : ''
      const cmd = `docker compose ${fileArg} --profile ${profile} stop`
      return execAsync(cmd, { timeout: 60_000 })
    },

    async listServices(composeFile: string): Promise<string[]> {
      const { stdout } = await execAsync(
        `docker compose -f ${composeFile} config --services`,
        { timeout: 30_000 },
      )
      return stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    },

    async recreateService(
      serviceId: string,
      composeFile: string,
    ): Promise<{ stdout: string; stderr: string }> {
      // --no-deps: apply env to THIS service only; dependencies keep running.
      // compose resolves the project dir (and its .env) from the file's path.
      return execAsync(
        `docker compose -f ${composeFile} up -d --force-recreate --no-deps ${serviceId}`,
        { timeout: 180_000 },
      )
    },
  }
}
