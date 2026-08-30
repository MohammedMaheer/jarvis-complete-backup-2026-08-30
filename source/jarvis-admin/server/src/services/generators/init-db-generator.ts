import type { ServiceDefinition } from '../../types/service-registry.js'

/**
 * Generates an init-db.sh script for postgres docker-entrypoint-initdb.d.
 * Creates all databases needed by enabled services.
 * The first database is created via POSTGRES_DB env var, so only additional ones need SQL.
 */
export function generateInitDbScript(
  enabledServices: ServiceDefinition[],
  primaryDb: string,
): string {
  const databases = enabledServices
    .filter((s) => s.database)
    .map((s) => s.database!)

  const additionalDbs = databases.filter((db) => db !== primaryDb)

  const lines = [
    '#!/bin/bash',
    'set -e',
    '',
    '# Create additional databases for Jarvis services',
    'psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL',
  ]

  for (const db of additionalDbs) {
    lines.push(
      `  SELECT 'CREATE DATABASE ${db}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${db}')\\gexec`,
    )
  }

  lines.push('EOSQL')
  lines.push('')

  return lines.join('\n')
}
