import { randomBytes } from 'node:crypto'

/**
 * Generates a cryptographically secure hex string using Node.js crypto.
 */
export function generateHexSecret(byteLength: number = 32): string {
  return randomBytes(byteLength).toString('hex')
}

export const SECRET_KEYS = [
  'AUTH_SECRET_KEY',
  'JARVIS_CONFIG_ADMIN_TOKEN',
  'JARVIS_AUTH_ADMIN_TOKEN',
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'ADMIN_API_KEY',
  // Internal auth between the llm-proxy API/worker and its model service (:7705).
  // The model service 503s ALL inference when this is unset (while /health stays
  // green), so it must be generated + injected on every install. No 'PASSWORD' in
  // the name -> 32 bytes / 64 hex, matching the installer.
  'MODEL_SERVICE_TOKEN',
  // Shared MQTT broker credential (username is the literal 'jarvis'). The
  // mosquitto container hashes this into a password_file at startup; every MQTT
  // client (command-center, nodes) authenticates with it. 'PASSWORD' in the name
  // -> 16 bytes / 32 hex. Preserved across regen so nodes keep authenticating.
  'MQTT_PASSWORD',
  // Grafana admin password. Without this the registry default was the well-known
  // literal 'jarvis' on a 0.0.0.0:3000 bind — any LAN client could log in and read
  // all Loki logs (voice transcripts / PII) + SSRF-pivot via the datasource proxy.
  // 'PASSWORD' in the name -> 16 bytes / 32 hex.
  'GRAFANA_ADMIN_PASSWORD',
  // CC-internal auth for async-job result callbacks (memory extraction, deep
  // research, characterization synthesis, adapter training). CC attaches it at
  // enqueue and validates it at the /…/callback endpoints (main.py:1714-1742,
  // FAIL-CLOSED): unset -> every callback 503s and the persist step never runs
  // (save_memory, transcript mark_processed, inbox delivery). Was unset on prod
  // -> passive memory extraction silently dead 2026-06-17..2026-08-07. Same
  // treatment as MODEL_SERVICE_TOKEN: no 'PASSWORD' in the name -> 32 bytes / 64 hex.
  'JARVIS_ADAPTER_CALLBACK_TOKEN',
] as const

export type SecretKey = (typeof SECRET_KEYS)[number]

/**
 * Generates all required secrets.
 * Passwords get 16 bytes (32 hex chars), auth secrets get 32 bytes (64 hex chars).
 */
export function generateAllSecrets(): Record<SecretKey, string> {
  const secrets: Record<string, string> = {}
  for (const key of SECRET_KEYS) {
    const byteLength = key.includes('PASSWORD') ? 16 : 32
    secrets[key] = generateHexSecret(byteLength)
  }
  return secrets as Record<SecretKey, string>
}
