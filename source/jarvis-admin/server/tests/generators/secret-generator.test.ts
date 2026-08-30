import { describe, it, expect } from 'vitest'
import { generateHexSecret, generateAllSecrets, SECRET_KEYS } from '../../src/services/generators/secret-generator.js'

describe('secret-generator', () => {
  describe('generateHexSecret', () => {
    it('generates a hex string of the expected length', () => {
      const secret = generateHexSecret(16)
      expect(secret).toHaveLength(32) // 16 bytes = 32 hex chars
    })

    it('defaults to 32 bytes (64 hex chars)', () => {
      const secret = generateHexSecret()
      expect(secret).toHaveLength(64)
    })

    it('generates unique values', () => {
      const a = generateHexSecret()
      const b = generateHexSecret()
      expect(a).not.toBe(b)
    })

    it('only contains hex characters', () => {
      const secret = generateHexSecret()
      expect(secret).toMatch(/^[0-9a-f]+$/)
    })
  })

  describe('generateAllSecrets', () => {
    it('generates all required secret keys', () => {
      const secrets = generateAllSecrets()
      for (const key of SECRET_KEYS) {
        expect(secrets[key]).toBeDefined()
        expect(secrets[key].length).toBeGreaterThan(0)
      }
    })

    it('uses 32 hex chars for passwords, 64 for auth secrets', () => {
      const secrets = generateAllSecrets()
      expect(secrets.POSTGRES_PASSWORD).toHaveLength(32)
      expect(secrets.REDIS_PASSWORD).toHaveLength(32)
      expect(secrets.AUTH_SECRET_KEY).toHaveLength(64)
      expect(secrets.JARVIS_CONFIG_ADMIN_TOKEN).toHaveLength(64)
      expect(secrets.JARVIS_ADAPTER_CALLBACK_TOKEN).toHaveLength(64)
    })

    it('includes MODEL_SERVICE_TOKEN as a 64-hex secret (llm-proxy <-> model service auth)', () => {
      expect(SECRET_KEYS).toContain('MODEL_SERVICE_TOKEN')
      const secrets = generateAllSecrets()
      expect(secrets.MODEL_SERVICE_TOKEN).toHaveLength(64)
    })

    it('includes GRAFANA_ADMIN_PASSWORD as a 32-hex password (replaces the admin/jarvis default)', () => {
      expect(SECRET_KEYS).toContain('GRAFANA_ADMIN_PASSWORD')
      const secrets = generateAllSecrets()
      expect(secrets.GRAFANA_ADMIN_PASSWORD).toHaveLength(32)
    })

    it('includes MQTT_PASSWORD as a 32-hex password (shared broker credential)', () => {
      // The broker password gates MQTT — without it in SECRET_KEYS the generator
      // would emit no MQTT_PASSWORD and the mosquitto password_file build fails.
      // 'PASSWORD' in the name -> 16 bytes / 32 hex.
      expect(SECRET_KEYS).toContain('MQTT_PASSWORD')
      const secrets = generateAllSecrets()
      expect(secrets.MQTT_PASSWORD).toHaveLength(32)
    })
  })
})
