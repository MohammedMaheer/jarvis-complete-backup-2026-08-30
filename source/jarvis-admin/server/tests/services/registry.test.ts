import { describe, it, expect, beforeAll } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRegistryService, type RegistryService } from '../../src/services/registry.js'

const FIXTURE_DIR = join(import.meta.dirname, '../fixtures')
const FIXTURE_PATH = join(FIXTURE_DIR, 'service-registry.json')

const testRegistry = {
  version: '1.0.0',
  services: [
    {
      id: 'auth',
      name: 'Jarvis Auth',
      description: 'JWT authentication service',
      category: 'core',
      port: 7701,
      image: 'jarvis-auth:latest',
      healthCheck: '/health',
      dependsOn: [],
      envVars: [{ name: 'SECRET_KEY', description: 'JWT signing key', required: true, secret: true }],
    },
    {
      id: 'command-center',
      name: 'Command Center',
      description: 'Central voice/command API',
      category: 'core',
      port: 7703,
      image: 'jarvis-command-center:latest',
      healthCheck: '/health',
      dependsOn: ['auth'],
      envVars: [],
    },
    {
      id: 'recipes',
      name: 'Jarvis Recipes',
      description: 'Recipe management',
      category: 'optional',
      port: 7030,
      image: 'jarvis-recipes:latest',
      healthCheck: '/health',
      dependsOn: ['auth'],
      envVars: [],
      profile: 'recipes',
    },
    {
      id: 'ocr',
      name: 'Jarvis OCR',
      description: 'OCR service',
      category: 'optional',
      port: 7031,
      image: 'jarvis-ocr:latest',
      healthCheck: '/health',
      dependsOn: [],
      envVars: [],
      profile: 'ocr',
    },
  ],
  infrastructure: [
    {
      id: 'postgres',
      name: 'PostgreSQL',
      description: 'Primary database',
      image: 'postgres:16',
      port: 5432,
      envVars: [{ name: 'POSTGRES_PASSWORD', description: 'DB password', required: true, secret: true }],
      volumes: ['postgres-data:/var/lib/postgresql/data'],
    },
  ],
}

describe('RegistryService', () => {
  let registry: RegistryService

  beforeAll(() => {
    mkdirSync(FIXTURE_DIR, { recursive: true })
    writeFileSync(FIXTURE_PATH, JSON.stringify(testRegistry, null, 2))
    registry = createRegistryService(FIXTURE_PATH)
  })

  it('loads the registry', () => {
    const reg = registry.getRegistry()
    expect(reg.version).toBe('1.0.0')
    expect(reg.services).toHaveLength(4)
    expect(reg.infrastructure).toHaveLength(1)
  })

  it('finds a service by id', () => {
    const auth = registry.getServiceById('auth')
    expect(auth).toBeDefined()
    expect(auth!.name).toBe('Jarvis Auth')
    expect(auth!.port).toBe(7701)
  })

  it('returns undefined for unknown id', () => {
    expect(registry.getServiceById('nonexistent')).toBeUndefined()
  })

  it('filters optional services', () => {
    const optional = registry.getOptionalServices()
    expect(optional).toHaveLength(2)
    expect(optional.map((s) => s.id)).toContain('recipes')
    expect(optional.map((s) => s.id)).toContain('ocr')
  })

  it('filters core services', () => {
    const core = registry.getCoreServices()
    expect(core).toHaveLength(2)
    expect(core.map((s) => s.id)).toContain('auth')
  })

  it('gets dependencies for a service', () => {
    expect(registry.getDependencies('command-center')).toEqual(['auth'])
    expect(registry.getDependencies('auth')).toEqual([])
  })

  it('gets dependents of a service', () => {
    const authDeps = registry.getDependents('auth')
    expect(authDeps).toContain('command-center')
    expect(authDeps).toContain('recipes')
    expect(authDeps).not.toContain('ocr')
  })

  it('reloads registry from disk', () => {
    // Write updated version
    const updated = { ...testRegistry, version: '2.0.0' }
    writeFileSync(FIXTURE_PATH, JSON.stringify(updated, null, 2))

    registry.reload()
    expect(registry.getRegistry().version).toBe('2.0.0')

    // Restore original
    writeFileSync(FIXTURE_PATH, JSON.stringify(testRegistry, null, 2))
    registry.reload()
  })
})
