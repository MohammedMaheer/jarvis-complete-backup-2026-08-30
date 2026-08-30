import { describe, it, expect } from 'vitest'
import { generateInitDbScript } from '../../src/services/generators/init-db-generator.js'
import type { ServiceDefinition } from '../../src/types/service-registry.js'

function makeService(id: string, database?: string): ServiceDefinition {
  return {
    id,
    name: id,
    description: '',
    category: 'core',
    port: 7700,
    image: '',
    healthCheck: '/health',
    dependsOn: [],
    envVars: [],
    database,
  }
}

describe('init-db-generator', () => {
  it('generates a valid bash script', () => {
    const services = [
      makeService('jarvis-config-service', 'jarvis_config'),
      makeService('jarvis-auth', 'jarvis_auth'),
    ]
    const script = generateInitDbScript(services, 'jarvis_config')
    expect(script).toContain('#!/bin/bash')
    expect(script).toContain('set -e')
    expect(script).toContain('EOSQL')
  })

  it('skips the primary database (created by POSTGRES_DB)', () => {
    const services = [
      makeService('jarvis-config-service', 'jarvis_config'),
      makeService('jarvis-auth', 'jarvis_auth'),
    ]
    const script = generateInitDbScript(services, 'jarvis_config')
    expect(script).not.toContain('CREATE DATABASE jarvis_config')
    expect(script).toContain('CREATE DATABASE jarvis_auth')
  })

  it('creates all additional databases', () => {
    const services = [
      makeService('jarvis-config-service', 'jarvis_config'),
      makeService('jarvis-auth', 'jarvis_auth'),
      makeService('jarvis-command-center', 'jarvis_command_center'),
    ]
    const script = generateInitDbScript(services, 'jarvis_config')
    expect(script).toContain('CREATE DATABASE jarvis_auth')
    expect(script).toContain('CREATE DATABASE jarvis_command_center')
  })

  it('ignores services without databases', () => {
    const services = [
      makeService('jarvis-tts'), // no database
    ]
    const script = generateInitDbScript(services, 'jarvis_config')
    expect(script).not.toContain('CREATE DATABASE')
  })
})
