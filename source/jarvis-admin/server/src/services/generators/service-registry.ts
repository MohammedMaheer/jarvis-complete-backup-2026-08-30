import type {
  ServiceRegistry,
  ServiceDefinition,
  InfrastructureDefinition,
} from '../../types/service-registry.js'

export function parseRegistry(json: unknown): ServiceRegistry {
  return json as ServiceRegistry
}

export function getCoreServices(registry: ServiceRegistry): ServiceDefinition[] {
  return registry.services.filter((s) => s.category === 'core')
}

export function getRecommendedServices(registry: ServiceRegistry): ServiceDefinition[] {
  return registry.services.filter((s) => s.category === 'recommended')
}

export function getOptionalServices(registry: ServiceRegistry): ServiceDefinition[] {
  return registry.services.filter((s) => s.category === 'optional')
}

export function getServicesByCategory(registry: ServiceRegistry): {
  core: ServiceDefinition[]
  recommended: ServiceDefinition[]
  optional: ServiceDefinition[]
} {
  return {
    core: getCoreServices(registry),
    recommended: getRecommendedServices(registry),
    optional: getOptionalServices(registry),
  }
}

export function getServiceById(
  registry: ServiceRegistry,
  id: string,
): ServiceDefinition | undefined {
  return registry.services.find((s) => s.id === id)
}

export function getInfraById(
  registry: ServiceRegistry,
  id: string,
): InfrastructureDefinition | undefined {
  return registry.infrastructure.find((i) => i.id === id)
}

export function getRequiredInfrastructure(
  registry: ServiceRegistry,
  enabledServiceIds: string[],
): InfrastructureDefinition[] {
  const infraIds = new Set<string>()

  for (const serviceId of enabledServiceIds) {
    const service = getServiceById(registry, serviceId)
    if (!service) continue

    for (const dep of service.dependsOn) {
      const infra = getInfraById(registry, dep)
      if (infra) {
        infraIds.add(dep)
      }
    }
  }

  return registry.infrastructure.filter((i) => infraIds.has(i.id))
}
