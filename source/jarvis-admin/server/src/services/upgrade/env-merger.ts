import { SECRET_KEYS } from '../generators/secret-generator.js'

const SECRET_SET = new Set<string>(SECRET_KEYS)

/**
 * Merge a newly generated .env template with existing env values.
 *
 * Rules:
 * - Existing non-empty values always win (preserves secrets, ports, app keys)
 * - New keys get their template defaults
 * - Secret keys are NEVER regenerated if they already exist
 * - Comments and blank lines from the template are preserved
 */
export function mergeEnv(
  existingEnv: Record<string, string>,
  newEnvTemplate: string,
): string {
  const lines: string[] = []

  for (const line of newEnvTemplate.split('\n')) {
    const trimmed = line.trim()

    // Preserve comments and blank lines
    if (!trimmed || trimmed.startsWith('#')) {
      lines.push(line)
      continue
    }

    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) {
      lines.push(line)
      continue
    }

    const key = trimmed.slice(0, eqIdx)
    const newValue = trimmed.slice(eqIdx + 1)
    const existingValue = existingEnv[key]

    if (existingValue !== undefined && existingValue !== '') {
      // Existing value wins
      lines.push(`${key}=${existingValue}`)
    } else if (SECRET_SET.has(key) && existingValue !== undefined) {
      // Secret exists but empty — keep the existing (empty) value rather than regenerating
      lines.push(`${key}=${existingValue}`)
    } else {
      // New key or no existing value — use template default
      lines.push(`${key}=${newValue}`)
    }
  }

  // Append any existing keys NOT in the template (e.g., app-to-app keys injected by registration)
  const templateKeys = new Set<string>()
  for (const line of newEnvTemplate.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx !== -1) templateKeys.add(trimmed.slice(0, eqIdx))
  }

  const extraLines: string[] = []
  for (const [key, value] of Object.entries(existingEnv)) {
    if (!templateKeys.has(key) && value !== '') {
      extraLines.push(`${key}=${value}`)
    }
  }

  if (extraLines.length > 0) {
    lines.push('')
    lines.push('# --- Preserved from previous install ---')
    lines.push(...extraLines)
  }

  return lines.join('\n')
}
