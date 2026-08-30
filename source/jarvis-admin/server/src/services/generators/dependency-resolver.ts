import type { ServiceRegistry } from '../../types/service-registry.js'
import { getOptionalServices, getServiceById } from './service-registry.js'

export interface ToggleResult {
  enabled: string[]
  warnings: string[]
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Returns optional service IDs that the given service depends on.
 * Core services and infrastructure are excluded — they're always available.
 */
export function getRequiredDependencies(
  registry: ServiceRegistry,
  serviceId: string,
): string[] {
  const service = getServiceById(registry, serviceId)
  if (!service) return []

  const optionalIds = new Set(getOptionalServices(registry).map((s) => s.id))

  return service.dependsOn.filter((dep) => optionalIds.has(dep))
}

/**
 * Resolves the effect of toggling a module on or off.
 * When enabling: auto-enables required optional dependencies.
 * When disabling: warns if other enabled modules depend on it.
 */
export function resolveModuleToggle(
  registry: ServiceRegistry,
  currentEnabled: string[],
  serviceId: string,
  enable: boolean,
): ToggleResult {
  if (enable) {
    const newEnabled = new Set(currentEnabled)
    newEnabled.add(serviceId)

    // Auto-enable optional dependencies
    const deps = getRequiredDependencies(registry, serviceId)
    for (const dep of deps) {
      newEnabled.add(dep)
    }

    return { enabled: [...newEnabled], warnings: [] }
  }

  // Disabling: check if any remaining enabled service depends on this one
  const warnings: string[] = []
  const remaining = currentEnabled.filter((id) => id !== serviceId)

  for (const otherId of remaining) {
    const deps = getRequiredDependencies(registry, otherId)
    if (deps.includes(serviceId)) {
      warnings.push(
        `${otherId} depends on ${serviceId} and may not work correctly without it`,
      )
    }
  }

  return { enabled: remaining, warnings }
}

/**
 * Validates that all optional dependencies for enabled modules are also enabled.
 */
export function validateModuleSelection(
  registry: ServiceRegistry,
  enabledIds: string[],
): ValidationResult {
  const errors: string[] = []
  const enabledSet = new Set(enabledIds)

  for (const serviceId of enabledIds) {
    const deps = getRequiredDependencies(registry, serviceId)
    for (const dep of deps) {
      if (!enabledSet.has(dep)) {
        errors.push(
          `${serviceId} requires ${dep} but it is not enabled`,
        )
      }
    }
  }

  return { valid: errors.length === 0, errors }
}
