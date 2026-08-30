import type { ServiceDefinition, InfrastructureDefinition } from '../../types/service-registry.js'

export interface PortEntry {
  id: string
  name: string
  port: number
}

/**
 * Detects port conflicts across services and infrastructure.
 * Returns a Map of port number → list of service/infra names sharing that port.
 * Only entries with 2+ names are actual conflicts.
 */
export function detectPortConflicts(
  entries: PortEntry[],
): Map<number, string[]> {
  const portMap = new Map<number, string[]>()

  for (const entry of entries) {
    const existing = portMap.get(entry.port) ?? []
    portMap.set(entry.port, [...existing, entry.name])
  }

  const conflicts = new Map<number, string[]>()
  for (const [port, names] of portMap) {
    if (names.length > 1) {
      conflicts.set(port, names)
    }
  }

  return conflicts
}

/**
 * Converts a service ID to a port environment variable name.
 * "jarvis-auth" → "AUTH_PORT"
 * "jarvis-command-center" → "COMMAND_CENTER_PORT"
 * "jarvis-config-service" → "CONFIG_SERVICE_PORT"
 */
export function serviceIdToPortVar(id: string): string {
  return (
    id
      .replace(/^jarvis-/, '')
      .replace(/-/g, '_')
      .toUpperCase() + '_PORT'
  )
}

/**
 * Builds a list of PortEntry objects from enabled services and required infrastructure.
 */
export function buildPortEntries(
  services: ServiceDefinition[],
  infrastructure: InfrastructureDefinition[],
  portOverrides: Record<string, number>,
  infraPortOverrides: Record<string, number>,
): PortEntry[] {
  const entries: PortEntry[] = []

  for (const svc of services) {
    entries.push({
      id: svc.id,
      name: svc.name,
      port: portOverrides[svc.id] ?? svc.port,
    })
  }

  for (const infra of infrastructure) {
    entries.push({
      id: infra.id,
      name: infra.name,
      port: infraPortOverrides[infra.id] ?? infra.port,
    })
  }

  return entries
}
