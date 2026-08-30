import { describe, it, expect } from 'vitest'
import { detectPortConflicts, serviceIdToPortVar, buildPortEntries } from '../../src/services/generators/port-utils.js'

describe('port-utils', () => {
  describe('serviceIdToPortVar', () => {
    it('converts jarvis-auth to AUTH_PORT', () => {
      expect(serviceIdToPortVar('jarvis-auth')).toBe('AUTH_PORT')
    })

    it('converts jarvis-command-center to COMMAND_CENTER_PORT', () => {
      expect(serviceIdToPortVar('jarvis-command-center')).toBe('COMMAND_CENTER_PORT')
    })

    it('converts jarvis-config-service to CONFIG_SERVICE_PORT', () => {
      expect(serviceIdToPortVar('jarvis-config-service')).toBe('CONFIG_SERVICE_PORT')
    })

    it('converts non-jarvis IDs', () => {
      expect(serviceIdToPortVar('postgres')).toBe('POSTGRES_PORT')
    })
  })

  describe('detectPortConflicts', () => {
    it('returns empty map when no conflicts', () => {
      const entries = [
        { id: 'a', name: 'Service A', port: 7700 },
        { id: 'b', name: 'Service B', port: 7701 },
      ]
      const conflicts = detectPortConflicts(entries)
      expect(conflicts.size).toBe(0)
    })

    it('detects port conflicts', () => {
      const entries = [
        { id: 'a', name: 'Service A', port: 7700 },
        { id: 'b', name: 'Service B', port: 7700 },
      ]
      const conflicts = detectPortConflicts(entries)
      expect(conflicts.size).toBe(1)
      expect(conflicts.get(7700)).toEqual(['Service A', 'Service B'])
    })
  })

  describe('buildPortEntries', () => {
    it('uses default ports when no overrides', () => {
      const services = [{ id: 'jarvis-auth', name: 'Auth', port: 7701 }] as never[]
      const infra = [{ id: 'postgres', name: 'PostgreSQL', port: 5432 }] as never[]
      const entries = buildPortEntries(services, infra, {}, {})
      expect(entries).toEqual([
        { id: 'jarvis-auth', name: 'Auth', port: 7701 },
        { id: 'postgres', name: 'PostgreSQL', port: 5432 },
      ])
    })

    it('applies port overrides', () => {
      const services = [{ id: 'jarvis-auth', name: 'Auth', port: 7701 }] as never[]
      const infra = [] as never[]
      const entries = buildPortEntries(services, infra, { 'jarvis-auth': 9999 }, {})
      expect(entries[0].port).toBe(9999)
    })
  })
})
