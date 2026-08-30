import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getRequiredDependencies,
  resolveModuleToggle,
  validateModuleSelection,
} from '../../src/services/generators/dependency-resolver.js'
import { parseRegistry } from '../../src/services/generators/service-registry.js'
import type { ServiceRegistry } from '../../src/types/service-registry.js'

function loadRegistry(): ServiceRegistry {
  const raw = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../src/data/service-registry.json'), 'utf-8'),
  )
  return parseRegistry(raw)
}

describe('dependency-resolver', () => {
  const registry = loadRegistry()

  describe('getRequiredDependencies', () => {
    it('returns empty for services with no optional deps', () => {
      const deps = getRequiredDependencies(registry, 'jarvis-auth')
      expect(deps).toEqual([])
    })

    it('returns optional dependencies for jarvis-web', () => {
      // jarvis-web depends on jarvis-auth + jarvis-command-center, both core
      const deps = getRequiredDependencies(registry, 'jarvis-web')
      expect(deps).toEqual([])
    })
  })

  describe('resolveModuleToggle', () => {
    it('adds service when enabling', () => {
      const result = resolveModuleToggle(registry, [], 'jarvis-web', true)
      expect(result.enabled).toContain('jarvis-web')
      expect(result.warnings).toHaveLength(0)
    })

    it('removes service when disabling', () => {
      const result = resolveModuleToggle(
        registry,
        ['jarvis-admin', 'jarvis-web'],
        'jarvis-admin',
        false,
      )
      expect(result.enabled).not.toContain('jarvis-admin')
      expect(result.enabled).toContain('jarvis-web')
    })
  })

  describe('validateModuleSelection', () => {
    it('passes for valid selections', () => {
      const result = validateModuleSelection(registry, ['jarvis-web'])
      expect(result.valid).toBe(true)
    })

    it('passes for empty selections', () => {
      const result = validateModuleSelection(registry, [])
      expect(result.valid).toBe(true)
    })
  })
})
