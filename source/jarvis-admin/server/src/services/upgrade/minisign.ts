import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'

// DER SubjectPublicKeyInfo prefix for an Ed25519 key — prepended to the raw
// 32-byte public key so Node's crypto can build a KeyObject from it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * Raw 32-byte Ed25519 key from a minisign public key (the base64 second line of
 * a `.pub`, or the bare base64). `null` if malformed.
 *
 * Layout: `[2-byte algo 'Ed'][8-byte key id][32-byte ed25519 pubkey]` = 42 bytes.
 */
function parsePublicKey(publicKeyB64: string): Buffer | null {
  let raw: Buffer
  try {
    raw = Buffer.from(publicKeyB64.trim(), 'base64')
  } catch {
    return null
  }
  if (raw.length !== 42 || raw[0] !== 0x45 || raw[1] !== 0x64) return null // 'Ed'
  return raw.subarray(10, 42)
}

/**
 * Parse a `.minisig` file's signature line → `{ prehashed, sig }`, or `null`.
 *
 * Layout of the (base64) 2nd line: `[2-byte algo][8-byte key id][64-byte sig]`.
 * algo `ED` (0x45,0x44) = prehashed (Ed25519 over BLAKE2b-512 of the file);
 * `Ed` (0x45,0x64) = legacy (Ed25519 over the file bytes).
 */
function parseSignature(minisigContent: string): { prehashed: boolean; sig: Buffer } | null {
  const lines = minisigContent.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return null
  let raw: Buffer
  try {
    raw = Buffer.from(lines[1], 'base64')
  } catch {
    return null
  }
  if (raw.length !== 74 || raw[0] !== 0x45) return null
  const mode = raw[1]
  if (mode !== 0x44 && mode !== 0x64) return null
  return { prehashed: mode === 0x44, sig: raw.subarray(10, 74) }
}

/**
 * Verify a minisign signature over `artifact` against `publicKeyB64` (the base64
 * line of a minisign public key). Returns true ONLY for a valid signature by
 * that key. Supports minisign's prehashed (BLAKE2b-512) and legacy modes.
 * In-language (Node crypto) — no `minisign` binary dependency.
 */
export function verifyMinisign(publicKeyB64: string, minisigContent: string, artifact: Buffer): boolean {
  const pub = parsePublicKey(publicKeyB64)
  const parsed = parseSignature(minisigContent)
  if (!pub || !parsed) return false

  const message = parsed.prehashed
    ? createHash('blake2b512').update(artifact).digest()
    : artifact

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, pub]),
      format: 'der',
      type: 'spki',
    })
    return cryptoVerify(null, message, key, parsed.sig)
  } catch {
    return false
  }
}

/**
 * Parse a `sha256sum`-format checksums file into filename → lowercase-hex-digest.
 * Handles both text (`hash␠␠name`) and binary (`hash␠*name`) lines; ignores any
 * malformed line. Only 64-hex digests are accepted, so a truncated/garbage line
 * can never masquerade as a valid checksum.
 */
export function parseChecksums(content: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of content.split('\n')) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (m) map.set(m[2].trim(), m[1].toLowerCase())
  }
  return map
}

export type UpdateVerificationInput = {
  /** The trusted minisign public key (base64 line) baked into the client. */
  publicKeyB64: string
  /** Raw bytes of the release's `checksums.txt`, or null if it couldn't be fetched. */
  checksums: Buffer | null
  /** Contents of the release's `checksums.txt.minisig`, or null if absent. */
  minisigContent: string | null
  /** Each downloaded artifact + its bytes, keyed by the filename in checksums.txt. */
  artifacts: { filename: string; data: Buffer }[]
  /** Operator opt-in (JARVIS_ALLOW_UNSIGNED_UPDATE) to accept an UNSIGNED release. */
  allowUnsigned: boolean
}

export type UpdateVerificationResult =
  | { allow: true; signed: boolean; note?: string }
  | { allow: false; reason: string }

/**
 * The self-update trust policy — pure, so it can be exhaustively tested without
 * touching the network or the filesystem.
 *
 *   - No signature material  → UNSIGNED. Allowed only if the operator opted in
 *     via `allowUnsigned`; we never fabricate trust.
 *   - Signature present but invalid for our key → refuse. This is a tampering /
 *     wrong-signer signal and is **not** overridable by `allowUnsigned` (the
 *     escape hatch covers "no signature", never "bad signature").
 *   - Signature valid → every artifact must be listed in checksums.txt AND match
 *     its SHA-256. Any missing/mismatched artifact → refuse (also not
 *     overridable — a validly-signed manifest that doesn't match the bytes we
 *     downloaded means the download was tampered).
 */
export function decideUpdateVerification(input: UpdateVerificationInput): UpdateVerificationResult {
  const { publicKeyB64, checksums, minisigContent, artifacts, allowUnsigned } = input

  if (!checksums || !minisigContent) {
    return allowUnsigned
      ? { allow: true, signed: false, note: 'release is unsigned; proceeding under JARVIS_ALLOW_UNSIGNED_UPDATE' }
      : { allow: false, reason: 'release is not signed (checksums.txt.minisig missing)' }
  }

  if (!verifyMinisign(publicKeyB64, minisigContent, checksums)) {
    return { allow: false, reason: 'checksums.txt signature is invalid for the trusted key' }
  }

  const hashes = parseChecksums(checksums.toString('utf-8'))
  for (const { filename, data } of artifacts) {
    const want = hashes.get(filename)
    if (!want) {
      return { allow: false, reason: `${filename} is not listed in the signed checksums.txt` }
    }
    const got = createHash('sha256').update(data).digest('hex')
    if (got !== want) {
      return { allow: false, reason: `${filename} does not match the signed checksums.txt (sha256 mismatch)` }
    }
  }

  return { allow: true, signed: true }
}
