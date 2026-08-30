import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildUpgradedComposeFiles } from '../../src/services/upgrade/compose-upgrader.js'
import { parseRegistry } from '../../src/services/generators/service-registry.js'

const FRESH = 'sha256:' + '1'.repeat(64)

function loadRegistry() {
  return parseRegistry(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../src/data/service-registry.json'), 'utf-8')),
  )
}

// Registry-conformant .env for a minimal existing install (mirrors the
// compose-upgrader fixture) so reconstructWizardState recognises it.
const existingEnv: Record<string, string> = {
  DB_USER: 'jarvis',
  POSTGRES_PASSWORD: 'p',
  AUTH_SECRET_KEY: 'a'.repeat(64),
  JARVIS_CONFIG_ADMIN_TOKEN: 'b'.repeat(64),
  JARVIS_AUTH_ADMIN_TOKEN: 'c'.repeat(64),
  ADMIN_API_KEY: 'd'.repeat(64),
  CONFIG_SERVICE_PORT: '7700',
  AUTH_PORT: '7701',
  LOG_SERVER_PORT: '7702',
  COMMAND_CENTER_PORT: '7703',
  TTS_PORT: '7707',
  JARVIS_IMAGE_TAG: 'latest',
  // Digest pinning is opt-in (2026-07-06): this suite tests the pin machinery.
  PIN_IMAGES: 'true',
}

describe('buildUpgradedComposeFiles honors a digest override', () => {
  const registry = loadRegistry()

  it('pins images to the provided fresh digest map (so `docker compose pull` gets the new build)', () => {
    // command-center is a core service, always present in the compose.
    const digests = { 'jarvis-command-center': { latest: FRESH } }
    const { compose } = buildUpgradedComposeFiles(existingEnv, registry, undefined, undefined, digests)
    expect(compose).toContain(`ghcr.io/alexberardi/jarvis-command-center@${FRESH}`)
  })
})
