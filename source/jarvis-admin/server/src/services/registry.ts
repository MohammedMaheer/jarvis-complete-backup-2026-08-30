import { readFileSync } from 'node:fs'

export interface EnvVar {
  name: string
  description: string
  required: boolean
  secret?: boolean
  default?: string
}

export interface ServiceDefinition {
  id: string
  name: string
  description: string
  category: 'core' | 'optional'
  port: number
  image: string
  healthCheck: string
  dependsOn: string[]
  envVars: EnvVar[]
  profile?: string
}

export interface InfrastructureDefinition {
  id: string
  name: string
  description: string
  image: string
  port: number
  envVars: EnvVar[]
  volumes: string[]
}

export interface ServiceRegistry {
  version: string
  services: ServiceDefinition[]
  infrastructure: InfrastructureDefinition[]
}

export interface RegistryService {
  getRegistry(): ServiceRegistry
  getServiceById(id: string): ServiceDefinition | undefined
  getOptionalServices(): ServiceDefinition[]
  getCoreServices(): ServiceDefinition[]
  getDependencies(id: string): string[]
  getDependents(id: string): string[]
  reload(): void
}

export function createRegistryService(path: string): RegistryService {
  let registry: ServiceRegistry = loadRegistry(path)

  return {
    getRegistry(): ServiceRegistry {
      return registry
    },

    getServiceById(id: string): ServiceDefinition | undefined {
      return registry.services.find((s) => s.id === id)
    },

    getOptionalServices(): ServiceDefinition[] {
      return registry.services.filter((s) => s.category === 'optional')
    },

    getCoreServices(): ServiceDefinition[] {
      return registry.services.filter((s) => s.category === 'core')
    },

    getDependencies(id: string): string[] {
      const service = registry.services.find((s) => s.id === id)
      return service?.dependsOn ?? []
    },

    getDependents(id: string): string[] {
      return registry.services.filter((s) => s.dependsOn.includes(id)).map((s) => s.id)
    },

    reload(): void {
      registry = loadRegistry(path)
    },
  }
}

function loadRegistry(path: string): ServiceRegistry {
  const raw = readFileSync(path, 'utf-8')
  return JSON.parse(raw) as ServiceRegistry
}
