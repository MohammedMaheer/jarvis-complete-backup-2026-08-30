import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Default go2rtc config: empty streams — command-center registers streams
 * dynamically at runtime.
 */
export const GO2RTC_DEFAULT_CONFIG = 'api:\n  listen: ":1984"\n\nstreams: {}\n'

/**
 * Seed go2rtc.yaml when go2rtc is enabled and no config exists yet.
 *
 * Shared by the fresh-install route AND the reconcile/upgrade path — the
 * compose bind is `${GO2RTC_CONFIG_PATH:-./go2rtc.yaml}:/config/go2rtc.yaml`,
 * so a go2rtc enabled without this file makes the docker daemon create an
 * empty DIRECTORY at the bind source and go2rtc boots unable to read its
 * config. (That was exactly the post-install-add gap: only the fresh-install
 * route seeded the file.)
 *
 * Never overwrites: users hand-edit streams into an existing go2rtc.yaml.
 *
 * @returns true if the file was written, false if skipped (disabled or exists)
 */
export function seedGo2rtcConfig(composePath: string, enabledServiceIds: string[]): boolean {
  if (!enabledServiceIds.includes('go2rtc')) return false
  const target = join(composePath, 'go2rtc.yaml')
  if (existsSync(target)) return false
  writeFileSync(target, GO2RTC_DEFAULT_CONFIG)
  return true
}
