import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { upgradeCompose, regenerateComposeFiles } from '../../src/services/upgrade/compose-upgrader.js'
import { resetHostPlatformCache } from '../../src/services/host-platform.js'

/**
 * Minimal valid starting state — registry-conformant .env keys for core services
 * so reconstructWizardState recognises an existing install.
 */
function writeFakeInstall(composePath: string, extra: Record<string, string> = {}): void {
  mkdirSync(composePath, { recursive: true })
  const envLines = [
    'DB_USER=jarvis',
    'POSTGRES_PASSWORD=p',
    'AUTH_SECRET_KEY=' + 'a'.repeat(64),
    'JARVIS_CONFIG_ADMIN_TOKEN=' + 'b'.repeat(64),
    'JARVIS_AUTH_ADMIN_TOKEN=' + 'c'.repeat(64),
    'ADMIN_API_KEY=' + 'd'.repeat(64),
    'CONFIG_SERVICE_PORT=7700',
    'AUTH_PORT=7701',
    'LOG_SERVER_PORT=7702',
    'COMMAND_CENTER_PORT=7703',
    'TTS_PORT=7707',
    ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
  ]
  writeFileSync(join(composePath, '.env'), envLines.join('\n') + '\n')
  writeFileSync(join(composePath, 'docker-compose.yml'), 'services: {}\n')
}

describe('upgradeCompose with UpgradeOverrides', () => {
  let composePath: string
  const fakeApp = {} as unknown as FastifyInstance

  beforeEach(() => {
    composePath = mkdtempSync(join(tmpdir(), 'jarvis-upgrade-'))
    process.env.JARVIS_COMPOSE_PATH = composePath
  })

  afterEach(() => {
    delete process.env.JARVIS_COMPOSE_PATH
    rmSync(composePath, { recursive: true, force: true })
  })

  it('honors relayEnabled + relayUrl override — writes to .env and templated env on CC', async () => {
    writeFakeInstall(composePath)

    await upgradeCompose(fakeApp, {
      relayEnabled: true,
      relayUrl: 'https://relay.example.com',
    })

    const env = readFileSync(join(composePath, '.env'), 'utf-8')
    expect(env).toContain('JARVIS_RELAY_URL=https://relay.example.com')

    const compose = readFileSync(join(composePath, 'docker-compose.yml'), 'utf-8')
    expect(compose).toContain('JARVIS_RELAY_URL: ${JARVIS_RELAY_URL:-}')
  })

  it('omits relay output when relayEnabled override is false', async () => {
    // Start with relay enabled in .env, then override to disabled.
    writeFakeInstall(composePath, { JARVIS_RELAY_URL: 'https://relay.example.com' })

    await upgradeCompose(fakeApp, { relayEnabled: false })

    // env-merger preserves existing values it doesn't recognise; relay may
    // remain in .env (won't hurt), but the compose drops the templated env
    // line entirely when relayEnabled is false.
    const compose = readFileSync(join(composePath, 'docker-compose.yml'), 'utf-8')
    expect(compose).not.toContain('JARVIS_RELAY_URL:')
  })

  it('honors enabledModules override — drops services missing from list', async () => {
    // Starting state: tts is enabled (TTS_PORT in .env). Override to disable it.
    writeFakeInstall(composePath)

    await upgradeCompose(fakeApp, { enabledModules: [] })

    const compose = readFileSync(join(composePath, 'docker-compose.yml'), 'utf-8')
    // jarvis-tts (recommended) should be gone; core services stay.
    expect(compose).toContain('jarvis-command-center:')
    expect(compose).not.toMatch(/^ {2}jarvis-tts:/m)
  })

  it('reconciles a relay-enabled install missing the household JWT — adds placeholder + wires notifications', async () => {
    // Reproduces the prod state: JARVIS_RELAY_URL is set, but neither
    // JARVIS_RELAY_HOUSEHOLD_JWT nor the per-container RELAY_* envs exist.
    writeFakeInstall(composePath, {
      JARVIS_RELAY_URL: 'https://relay.jarvisautomation.io',
      NOTIFICATIONS_PORT: '7712',
    })

    await upgradeCompose(fakeApp)

    const env = readFileSync(join(composePath, '.env'), 'utf-8')
    expect(env).toContain('JARVIS_RELAY_URL=https://relay.jarvisautomation.io')
    expect(env).toMatch(/JARVIS_RELAY_HOUSEHOLD_JWT=\s*$/m)

    const compose = readFileSync(join(composePath, 'docker-compose.yml'), 'utf-8')
    const notifIdx = compose.indexOf('jarvis-notifications:')
    const nextSvcIdx = compose.indexOf('\n  jarvis-', notifIdx + 1)
    const notifBlock = compose.slice(notifIdx, nextSvcIdx === -1 ? undefined : nextSvcIdx)
    expect(notifBlock).toContain('RELAY_URL: ${JARVIS_RELAY_URL:-}')
    expect(notifBlock).toContain('RELAY_HOUSEHOLD_JWT: ${JARVIS_RELAY_HOUSEHOLD_JWT:-}')
  })

  it('preserves an existing JARVIS_RELAY_HOUSEHOLD_JWT through reconcile', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.preserved'
    writeFakeInstall(composePath, {
      JARVIS_RELAY_URL: 'https://relay.jarvisautomation.io',
      JARVIS_RELAY_HOUSEHOLD_JWT: jwt,
      NOTIFICATIONS_PORT: '7712',
    })

    await upgradeCompose(fakeApp)

    const env = readFileSync(join(composePath, '.env'), 'utf-8')
    expect(env).toContain(`JARVIS_RELAY_HOUSEHOLD_JWT=${jwt}`)
  })

  it('migrates every registry migrate-set service on regenerate — including the previously-missing config-service', async () => {
    // Root incident: config-service shipped migration 005 (services.external_host)
    // but its compose never ran `alembic upgrade head`, so every /services query
    // 500'd. The upgrader must now wrap EVERY registry `migrate: true` service in
    // the alembic-then-exec entrypoint, not just cc/whisper/llm-proxy.
    writeFakeInstall(composePath)

    await upgradeCompose(fakeApp)

    const compose = readFileSync(join(composePath, 'docker-compose.yml'), 'utf-8')

    function block(id: string): string {
      const start = compose.indexOf(`\n  ${id}:\n`)
      expect(start, `${id} missing from regenerated compose`).toBeGreaterThanOrEqual(0)
      const after = compose.slice(start + `\n  ${id}:\n`.length)
      const next = after.match(/\n {2}[a-z][a-z0-9-]*:\n/)
      return next ? after.slice(0, next.index) : after
    }

    // Every enabled `migrate: true` service must carry the entrypoint wrapper —
    // including config-service, the one that 500'd.
    for (const id of [
      'jarvis-config-service',
      'jarvis-auth',
      'jarvis-command-center',
    ]) {
      const b = block(id)
      expect(b, `${id} should have the migrate entrypoint`).toContain('entrypoint:')
      expect(b).toContain('python -m alembic upgrade head && exec "$@"')
      expect(b).toContain('- jarvis-migrate')
    }

    // ...and an enabled service that is NOT in the migrate set must NOT get it —
    // proves the registry flag gates the wrapper. jarvis-logs is intentionally
    // deferred (its image doesn't ship alembic and its prod DB is un-stamped),
    // so it must come up exactly as before, with no migrate entrypoint.
    expect(block('jarvis-logs'), 'deferred service must not get the migrate entrypoint')
      .not.toContain('jarvis-migrate')
  })

  it('creates a backup directory before regenerating', async () => {
    writeFakeInstall(composePath)

    await upgradeCompose(fakeApp, { relayEnabled: true })

    // backup-<VERSION> dir should exist with the pre-upgrade docker-compose.yml
    const backupDirs = ['backup-0.0.0-dev', 'backup-dev'].concat(
      Array.from({ length: 50 }, (_, i) => `backup-0.1.${i}`),
    )
    const found = backupDirs.find((d) => existsSync(join(composePath, d)))
    expect(found).toBeDefined()
  })
})

describe('regenerateComposeFiles (non-destructive)', () => {
  let composePath: string

  beforeEach(() => {
    composePath = mkdtempSync(join(tmpdir(), 'jarvis-regen-'))
    process.env.JARVIS_COMPOSE_PATH = composePath
  })

  afterEach(() => {
    delete process.env.JARVIS_COMPOSE_PATH
    rmSync(composePath, { recursive: true, force: true })
  })

  it('returns regenerated files as strings without touching the originals', () => {
    writeFakeInstall(composePath)
    const originalCompose = readFileSync(join(composePath, 'docker-compose.yml'), 'utf-8')
    const originalEnv = readFileSync(join(composePath, '.env'), 'utf-8')

    const result = regenerateComposeFiles(composePath)

    // Produced a real, fuller compose than the stub we started with.
    expect(result.compose).toContain('services:')
    expect(result.compose.length).toBeGreaterThan(originalCompose.length)
    expect(result.initDb.length).toBeGreaterThan(0)

    // Source files are byte-for-byte untouched.
    expect(readFileSync(join(composePath, 'docker-compose.yml'), 'utf-8')).toBe(originalCompose)
    expect(readFileSync(join(composePath, '.env'), 'utf-8')).toBe(originalEnv)
  })

  it('preserves existing secrets in the regenerated env', () => {
    writeFakeInstall(composePath)

    const result = regenerateComposeFiles(composePath)

    // The old secret values are carried forward, not re-minted.
    expect(result.env).toContain('AUTH_SECRET_KEY=' + 'a'.repeat(64))
    expect(result.env).toContain('JARVIS_AUTH_ADMIN_TOKEN=' + 'c'.repeat(64))
    expect(result.env).toContain('ADMIN_API_KEY=' + 'd'.repeat(64))
  })

  it('applies overrides in the returned files', () => {
    writeFakeInstall(composePath)

    const result = regenerateComposeFiles(composePath, {
      relayEnabled: true,
      relayUrl: 'https://relay.example.com',
    })

    expect(result.env).toContain('JARVIS_RELAY_URL=https://relay.example.com')
  })

  it('preserves the whisper CUDA backend across a plain regen (no override)', () => {
    // The compose pins images by digest, so the backend choice lives only in
    // .env — losing it is a silent GPU→CPU downgrade on the next reconcile
    // (prod 2026-07-04: STT went ~90ms → ~16s when a regen swapped -cuda
    // for the CPU image).
    writeFakeInstall(composePath, { WHISPER_API_PORT: '7706', WHISPER_BACKEND: 'cuda' })

    const result = regenerateComposeFiles(composePath)

    expect(result.env).toContain('WHISPER_BACKEND=cuda')
    const whisperBlock = /\n {2}jarvis-whisper-api:[\s\S]*?(?=\n {2}\S|$)/.exec(result.compose)?.[0]
    expect(whisperBlock).toBeDefined()
    expect(whisperBlock).toContain('driver: nvidia')
  })

  it('degrades an unrecognized WHISPER_BACKEND value to a cpu compose', () => {
    writeFakeInstall(composePath, { WHISPER_API_PORT: '7706', WHISPER_BACKEND: 'metal' })

    const result = regenerateComposeFiles(composePath)

    // The merger's "existing non-empty values win" invariant keeps the raw
    // .env value, but the reconstructed state — and thus the compose — must
    // degrade to the cpu variant rather than fail or emit a bogus image tag.
    const whisperBlock = /\n {2}jarvis-whisper-api:[\s\S]*?(?=\n {2}\S|$)/.exec(result.compose)?.[0]
    expect(whisperBlock).toBeDefined()
    expect(whisperBlock).not.toContain('driver: nvidia')
    expect(whisperBlock).not.toContain('-metal')
  })

  it('preserves the TTS cuda backend and GPU pin across a plain regen', () => {
    writeFakeInstall(composePath, { TTS_BACKEND: 'cuda', TTS_GPU_DEVICE: '1' })

    const result = regenerateComposeFiles(composePath)

    expect(result.env).toContain('TTS_BACKEND=cuda')
    expect(result.env).toContain('TTS_GPU_DEVICE=1')
    const ttsBlock = /\n {2}jarvis-tts:[\s\S]*?(?=\n {2}\S|$)/.exec(result.compose)?.[0]
    expect(ttsBlock).toBeDefined()
    expect(ttsBlock).toContain("device_ids: ['${TTS_GPU_DEVICE:-0}']")
  })

  it('preserves the existing MQTT_PASSWORD across regen (nodes hold this password)', () => {
    // Re-minting the broker password on regen would silently orphan every node
    // (they carry the old password in their config) once the broker locks down.
    writeFakeInstall(composePath, { MQTT_PASSWORD: 'e'.repeat(32) })

    const result = regenerateComposeFiles(composePath)

    expect(result.env).toContain('MQTT_PASSWORD=' + 'e'.repeat(32))
  })

  it('locks the broker when mqttAllowAnon override is false', () => {
    writeFakeInstall(composePath)
    const result = regenerateComposeFiles(composePath, { mqttAllowAnon: false })
    expect(result.env).toContain('MQTT_ALLOW_ANON=false')
  })

  it('unlocks (override true) even when the existing .env had the broker locked', () => {
    // The lock flag is operational — an explicit flip must win over mergeEnv's
    // "existing value wins" preservation rule.
    writeFakeInstall(composePath, { MQTT_ALLOW_ANON: 'false' })
    const result = regenerateComposeFiles(composePath, { mqttAllowAnon: true })
    expect(result.env).toContain('MQTT_ALLOW_ANON=true')
    expect(result.env).not.toContain('MQTT_ALLOW_ANON=false')
  })

  it('preserves an existing broker lock across a plain regen (no override)', () => {
    // Once locked, a routine regenerate must not silently re-open the broker.
    writeFakeInstall(composePath, { MQTT_ALLOW_ANON: 'false' })
    const result = regenerateComposeFiles(composePath)
    expect(result.env).toContain('MQTT_ALLOW_ANON=false')
  })

  it('forces the transition window (true) when upgrading an install that predates locked-by-default', () => {
    // The fresh-install template now emits MQTT_ALLOW_ANON=false, but an in-place
    // upgrade of a fleet whose .env never had the key must NOT inherit that lock:
    // its nodes may not have fetched broker creds yet, so locking would drop them
    // all. The upgrader keeps the broker open until the operator locks explicitly.
    writeFakeInstall(composePath) // fixture .env has no MQTT_ALLOW_ANON
    const result = regenerateComposeFiles(composePath)
    expect(result.env).toContain('MQTT_ALLOW_ANON=true')
    expect(result.env).not.toContain('MQTT_ALLOW_ANON=false')
  })

  it('switching to the dev track rewrites JARVIS_IMAGE_TAG over an existing latest', () => {
    // The compose references images as ${JARVIS_IMAGE_TAG:-latest}, so the track
    // change is ONLY effective if the .env value flips — mergeEnv's "existing
    // value wins" rule must not eat an explicit track override.
    writeFakeInstall(composePath, { JARVIS_IMAGE_TAG: 'latest' })
    const result = regenerateComposeFiles(composePath, { releaseTrack: 'dev' })
    expect(result.env).toContain('JARVIS_IMAGE_TAG=dev')
    expect(result.env).not.toContain('JARVIS_IMAGE_TAG=latest')
  })

  it('switching back to stable rewrites JARVIS_IMAGE_TAG to latest', () => {
    writeFakeInstall(composePath, { JARVIS_IMAGE_TAG: 'dev' })
    const result = regenerateComposeFiles(composePath, { releaseTrack: 'stable' })
    expect(result.env).toContain('JARVIS_IMAGE_TAG=latest')
    expect(result.env).not.toContain('JARVIS_IMAGE_TAG=dev')
  })

  it('preserves the dev track across a plain regen (no override)', () => {
    writeFakeInstall(composePath, { JARVIS_IMAGE_TAG: 'dev' })
    const result = regenerateComposeFiles(composePath)
    expect(result.env).toContain('JARVIS_IMAGE_TAG=dev')
  })

  it('preserves a hand-set custom tag across a plain regen (no override)', () => {
    // Only an explicit releaseTrack override may rewrite the tag — an operator
    // who hand-pinned a specific version must keep it through routine regens.
    writeFakeInstall(composePath, { JARVIS_IMAGE_TAG: 'v0.1.80' })
    const result = regenerateComposeFiles(composePath)
    expect(result.env).toContain('JARVIS_IMAGE_TAG=v0.1.80')
  })
})

describe('operational-state stickiness (2026-07-06: "buttons must respect each other")', () => {
  let composePath: string
  const fakeApp = {} as unknown as import('fastify').FastifyInstance

  beforeEach(() => {
    composePath = mkdtempSync(join(tmpdir(), 'jarvis-sticky-'))
    process.env.JARVIS_COMPOSE_PATH = composePath
  })

  afterEach(() => {
    delete process.env.JARVIS_COMPOSE_PATH
    rmSync(composePath, { recursive: true, force: true })
  })

  it('preserves an UNLOCKED broker (MQTT_ALLOW_ANON=true) across a plain regen', () => {
    // The exact 2026-07-06 complaint: the user unlocks the broker, then a
    // later Update/reconcile must not silently re-lock it.
    writeFakeInstall(composePath, { MQTT_ALLOW_ANON: 'true' })

    const result = regenerateComposeFiles(composePath)

    expect(result.env).toMatch(/^MQTT_ALLOW_ANON=true$/m)
  })

  it('an explicit unlock via upgradeCompose stays unlocked on the NEXT plain regen', async () => {
    // Button-respects-button across two separate operations: unlock once,
    // then a later regen with no overrides keeps the unlock.
    writeFakeInstall(composePath, { MQTT_ALLOW_ANON: 'false' })

    await upgradeCompose(fakeApp, { mqttAllowAnon: true })
    expect(readFileSync(join(composePath, '.env'), 'utf-8')).toMatch(/^MQTT_ALLOW_ANON=true$/m)

    const later = regenerateComposeFiles(composePath)
    expect(later.env).toMatch(/^MQTT_ALLOW_ANON=true$/m)
  })

  it('an explicit lock stays locked on the NEXT plain regen', async () => {
    writeFakeInstall(composePath, { MQTT_ALLOW_ANON: 'true' })

    await upgradeCompose(fakeApp, { mqttAllowAnon: false })
    const later = regenerateComposeFiles(composePath)
    expect(later.env).toMatch(/^MQTT_ALLOW_ANON=false$/m)
  })

  it('backend/pin selections applied once stick through the NEXT plain regen', async () => {
    writeFakeInstall(composePath, { WHISPER_API_PORT: '7706' })

    await upgradeCompose(fakeApp, { whisperBackend: 'cuda', ttsBackend: 'cuda', pinImages: false })

    const later = regenerateComposeFiles(composePath)
    expect(later.env).toMatch(/^WHISPER_BACKEND=cuda$/m)
    expect(later.env).toMatch(/^TTS_BACKEND=cuda$/m)
    expect(later.env).toMatch(/^PIN_IMAGES=false$/m)
    const whisper = /\n {2}jarvis-whisper-api:[\s\S]*?(?=\n {2}\S|$)/.exec(later.compose)?.[0]
    expect(whisper).toContain('-cuda')
    expect(whisper).toContain('driver: nvidia')
  })

  it('a whisper-model override is written to .env + compose and sticks through the NEXT plain regen', async () => {
    writeFakeInstall(composePath, { WHISPER_API_PORT: '7706' })

    await upgradeCompose(fakeApp, { whisperModelPath: '/whisper-models/ggml-small.en.bin' })

    const later = regenerateComposeFiles(composePath)
    expect(later.env).toMatch(/^WHISPER_MODEL=\/whisper-models\/ggml-small\.en\.bin$/m)
    const whisper = /\n {2}jarvis-whisper-api:[\s\S]*?(?=\n {2}\S|$)/.exec(later.compose)?.[0]
    expect(whisper).toContain('WHISPER_MODEL: /whisper-models/ggml-small.en.bin')
  })

  it('background-sidecar enable + model file stick through the NEXT plain regen', async () => {
    process.env.HOST_OS = 'linux'
    resetHostPlatformCache()
    try {
      writeFakeInstall(composePath, {})

      await upgradeCompose(fakeApp, { bgModelEnabled: true, bgModelFile: 'Qwen3.8-27B-UD-Q3_K_XL.gguf' })
      expect(readFileSync(join(composePath, '.env'), 'utf-8')).toMatch(/^BG_MODEL_ENABLED=true$/m)

      const later = regenerateComposeFiles(composePath)
      expect(later.env).toMatch(/^BG_MODEL_ENABLED=true$/m)
      expect(later.env).toMatch(/^BG_MODEL_FILE=Qwen3\.8-27B-UD-Q3_K_XL\.gguf$/m)
      expect(later.compose).toContain('container_name: llama-server-bg')
      expect(later.compose).toContain('"--jinja"')
    } finally {
      delete process.env.HOST_OS
      resetHostPlatformCache()
    }
  })

  it('disabling the background sidecar removes the service and sticks', async () => {
    process.env.HOST_OS = 'linux'
    resetHostPlatformCache()
    try {
      writeFakeInstall(composePath, { BG_MODEL_ENABLED: 'true', BG_MODEL_FILE: 'x.gguf' })

      await upgradeCompose(fakeApp, { bgModelEnabled: false })

      const later = regenerateComposeFiles(composePath)
      expect(later.env).toMatch(/^BG_MODEL_ENABLED=false$/m)
      expect(later.compose).not.toContain('llama-server-bg')
    } finally {
      delete process.env.HOST_OS
      resetHostPlatformCache()
    }
  })

  it('a bare BG_MODEL_FILE with no BG_MODEL_ENABLED key infers the sidecar on (legacy/hand-set .env)', () => {
    process.env.HOST_OS = 'linux'
    resetHostPlatformCache()
    try {
      writeFakeInstall(composePath, { BG_MODEL_FILE: 'hand-set.gguf' })

      const later = regenerateComposeFiles(composePath)
      expect(later.compose).toContain('container_name: llama-server-bg')
    } finally {
      delete process.env.HOST_OS
      resetHostPlatformCache()
    }
  })

  it('recovers a non-base WHISPER_MODEL from the running compose when .env lacks it (legacy stack)', () => {
    writeFakeInstall(composePath, { WHISPER_API_PORT: '7706' })
    // Pre-persistence install: the model lives only in the compose environment
    // block, never in .env — a naive reconstruct would reset it to base.en.
    writeFileSync(
      join(composePath, 'docker-compose.yml'),
      [
        'services:',
        '  jarvis-whisper-api:',
        '    environment:',
        '      WHISPER_MODEL: /whisper-models/ggml-medium.en.bin',
        '',
      ].join('\n'),
    )

    const result = regenerateComposeFiles(composePath)

    expect(result.env).toMatch(/^WHISPER_MODEL=\/whisper-models\/ggml-medium\.en\.bin$/m)
    const whisper = /\n {2}jarvis-whisper-api:[\s\S]*?(?=\n {2}\S|$)/.exec(result.compose)?.[0]
    expect(whisper).toContain('WHISPER_MODEL: /whisper-models/ggml-medium.en.bin')
  })

  it('a default base.en install records the model in .env but omits it from the whisper service', () => {
    writeFakeInstall(composePath, { WHISPER_API_PORT: '7706' })

    const result = regenerateComposeFiles(composePath)

    // .env carries the model for durable reconstruct...
    expect(result.env).toMatch(/^WHISPER_MODEL=\/whisper-models\/ggml-base\.en\.bin$/m)
    // ...but the compose omits it (whisper's built-in default is base.en).
    const whisper = /\n {2}jarvis-whisper-api:[\s\S]*?(?=\n {2}\S|$)/.exec(result.compose)?.[0]
    expect(whisper).not.toContain('WHISPER_MODEL:')
  })

  it('PIN_IMAGES=true is preserved across a plain regen (pins stay pinned when chosen)', () => {
    writeFakeInstall(composePath, { PIN_IMAGES: 'true' })

    const result = regenerateComposeFiles(composePath)

    expect(result.env).toMatch(/^PIN_IMAGES=true$/m)
  })

  it('a legacy pinned install with no PIN_IMAGES key heals to floating tags', () => {
    writeFakeInstall(composePath)

    const result = regenerateComposeFiles(composePath)

    expect(result.env).toMatch(/^PIN_IMAGES=false$/m)
    expect(result.compose).not.toContain('@sha256:')
  })

  it('the "Update stack to latest" flow preserves broker state + backends (offline digest refresh degrades gracefully)', async () => {
    writeFakeInstall(composePath, {
      MQTT_ALLOW_ANON: 'true',
      WHISPER_API_PORT: '7706',
      WHISPER_BACKEND: 'cuda',
      TTS_BACKEND: 'cuda',
      TTS_GPU_DEVICE: '1',
    })

    const { regenerateComposeFilesLatest } = await import('../../src/services/upgrade/compose-upgrader.js')
    const result = await regenerateComposeFilesLatest(composePath)

    expect(result.env).toMatch(/^MQTT_ALLOW_ANON=true$/m)
    expect(result.env).toMatch(/^WHISPER_BACKEND=cuda$/m)
    expect(result.env).toMatch(/^TTS_BACKEND=cuda$/m)
    expect(result.env).toMatch(/^TTS_GPU_DEVICE=1$/m)
    const whisper = /\n {2}jarvis-whisper-api:[\s\S]*?(?=\n {2}\S|$)/.exec(result.compose)?.[0]
    expect(whisper).toContain('-cuda')
  })
})

describe('reconcile seeds go2rtc.yaml (post-install add gap)', () => {
  let composePath: string
  const fakeApp = {} as unknown as FastifyInstance

  beforeEach(() => {
    composePath = mkdtempSync(join(tmpdir(), 'jarvis-go2rtc-'))
    process.env.JARVIS_COMPOSE_PATH = composePath
  })

  afterEach(() => {
    delete process.env.JARVIS_COMPOSE_PATH
    rmSync(composePath, { recursive: true, force: true })
  })

  it('reconcile that newly enables go2rtc creates go2rtc.yaml', async () => {
    writeFakeInstall(composePath)
    expect(existsSync(join(composePath, 'go2rtc.yaml'))).toBe(false)

    await upgradeCompose(fakeApp, {
      enabledModules: ['jarvis-tts', 'go2rtc'],
    })

    expect(existsSync(join(composePath, 'go2rtc.yaml'))).toBe(true)
    const content = readFileSync(join(composePath, 'go2rtc.yaml'), 'utf-8')
    expect(content).toContain('streams: {}')
  })

  it('reconcile never overwrites an existing hand-edited go2rtc.yaml', async () => {
    writeFakeInstall(composePath, { GO2RTC_PORT: '1984' })
    const handEdited = 'api:\n  listen: ":1984"\n\nstreams:\n  doorbell: rtsp://cam/1\n'
    writeFileSync(join(composePath, 'go2rtc.yaml'), handEdited)

    await upgradeCompose(fakeApp, {})

    expect(readFileSync(join(composePath, 'go2rtc.yaml'), 'utf-8')).toBe(handEdited)
  })

  it('reconcile without go2rtc does not create the file', async () => {
    writeFakeInstall(composePath)

    await upgradeCompose(fakeApp, { enabledModules: ['jarvis-tts'] })

    expect(existsSync(join(composePath, 'go2rtc.yaml'))).toBe(false)
  })
})

describe('reconcile can add jarvis-phone-gateway post-install', () => {
  let composePath: string
  const fakeApp = {} as unknown as FastifyInstance

  beforeEach(() => {
    composePath = mkdtempSync(join(tmpdir(), 'jarvis-phonegw-'))
    process.env.JARVIS_COMPOSE_PATH = composePath
  })

  afterEach(() => {
    delete process.env.JARVIS_COMPOSE_PATH
    rmSync(composePath, { recursive: true, force: true })
  })

  it('enabling jarvis-phone-gateway emits its compose block + env plumbing', async () => {
    writeFakeInstall(composePath)

    await upgradeCompose(fakeApp, {
      enabledModules: ['jarvis-tts', 'jarvis-phone-gateway'],
    })

    const compose = readFileSync(join(composePath, 'docker-compose.yml'), 'utf-8')
    expect(compose).toContain('jarvis-phone-gateway:')
    expect(compose).toContain('${PHONE_GATEWAY_PORT:-7713}:7713')

    const env = readFileSync(join(composePath, '.env'), 'utf-8')
    expect(env).toContain('PHONE_GATEWAY_PORT=7713')
    expect(env).toContain('TWILIO_ACCOUNT_SID=')
    // Selection round-trips: a second reconcile with no overrides keeps it.
    await upgradeCompose(fakeApp, {})
    const compose2 = readFileSync(join(composePath, 'docker-compose.yml'), 'utf-8')
    expect(compose2).toContain('jarvis-phone-gateway:')
  })

  it('reconcile preserves pasted Twilio credentials (mergeEnv)', async () => {
    writeFakeInstall(composePath, {
      PHONE_GATEWAY_PORT: '7713',
      TWILIO_ACCOUNT_SID: 'ACxxxx',
      TWILIO_AUTH_TOKEN: 'tok-secret',
      TWILIO_FROM_NUMBER: '+15550001111',
    })

    await upgradeCompose(fakeApp, {})

    const env = readFileSync(join(composePath, '.env'), 'utf-8')
    expect(env).toContain('TWILIO_ACCOUNT_SID=ACxxxx')
    expect(env).toContain('TWILIO_AUTH_TOKEN=tok-secret')
    expect(env).toContain('TWILIO_FROM_NUMBER=+15550001111')
  })
})
