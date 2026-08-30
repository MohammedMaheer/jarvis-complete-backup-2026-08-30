import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPairSync, sign as edSign, createHash } from 'node:crypto'
import { verifyMinisign, parseChecksums, decideUpdateVerification } from '../../src/services/upgrade/minisign.js'

/**
 * Mint a minisign-compatible Ed25519 keypair with Node crypto so we can sign
 * REAL checksums over REAL artifact bytes in-test (the committed fixtures use
 * dummy hashes and we never commit a secret key). Legacy mode ('Ed' 0x45,0x64)
 * = raw Ed25519 over the file bytes, which verifyMinisign supports.
 */
function makeMinisignKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const keyId = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
  const pubB64 = Buffer.concat([Buffer.from([0x45, 0x64]), keyId, rawPub]).toString('base64')
  const signLegacy = (msg: Buffer): string => {
    const sig = edSign(null, msg, privateKey)
    const blob = Buffer.concat([Buffer.from([0x45, 0x64]), keyId, sig])
    return `untrusted comment: test\n${blob.toString('base64')}\n`
  }
  return { pubB64, signLegacy }
}

const sha256hex = (b: Buffer) => createHash('sha256').update(b).digest('hex')

// Fixtures were produced by the REAL `minisign` binary (see how they were
// generated in the PR): a signer keypair signs checksums.txt; a tampered copy
// keeps the signature but changes the bytes; wrong.pub is an unrelated key.
const DIR = join(import.meta.dirname, '../fixtures/minisign')
const readText = (f: string) => readFileSync(join(DIR, f), 'utf-8')
const readLfBytes = (f: string) => Buffer.from(readText(f).replace(/\r\n/g, '\n'))
const pubLine = (f: string) => readText(f).split('\n')[1].trim() // base64 line of a .pub

describe('verifyMinisign', () => {
  const signerPub = pubLine('signer.pub')
  const wrongPub = pubLine('wrong.pub')

  it('accepts a genuine signature by the trusted key', () => {
    expect(verifyMinisign(signerPub, readText('checksums.txt.minisig'), readLfBytes('checksums.txt'))).toBe(true)
  })

  it('rejects a tampered artifact (same signature, changed bytes)', () => {
    expect(
      verifyMinisign(signerPub, readText('checksums.tampered.txt.minisig'), readLfBytes('checksums.tampered.txt')),
    ).toBe(false)
  })

  it('rejects a valid signature verified against the WRONG public key', () => {
    expect(verifyMinisign(wrongPub, readText('checksums.txt.minisig'), readLfBytes('checksums.txt'))).toBe(false)
  })

  it('rejects a malformed public key', () => {
    expect(verifyMinisign('not-base64!!', readText('checksums.txt.minisig'), readLfBytes('checksums.txt'))).toBe(false)
    expect(verifyMinisign('', readText('checksums.txt.minisig'), readLfBytes('checksums.txt'))).toBe(false)
  })

  it('rejects a malformed / empty signature file', () => {
    expect(verifyMinisign(signerPub, 'garbage', readLfBytes('checksums.txt'))).toBe(false)
    expect(verifyMinisign(signerPub, '', readLfBytes('checksums.txt'))).toBe(false)
  })
})

describe('parseChecksums', () => {
  it('parses sha256sum text + binary lines and ignores junk', () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    const m = parseChecksums(`${a}  file one.txt\n${b} *bin.tar.gz\ngarbage line\n\n`)
    expect(m.get('file one.txt')).toBe(a)
    expect(m.get('bin.tar.gz')).toBe(b)
    expect(m.size).toBe(2)
  })

  it('rejects a non-64-hex digest so garbage cannot masquerade as a checksum', () => {
    expect(parseChecksums('abc123  short\n').size).toBe(0)
  })
})

describe('decideUpdateVerification (self-update trust policy)', () => {
  const { pubB64, signLegacy } = makeMinisignKeypair()
  const bin = Buffer.from('fake admin binary bytes')
  const tar = Buffer.from('fake public.tar.gz bytes')
  const checksums = Buffer.from(
    `${sha256hex(bin)}  jarvis-admin-linux-x64\n${sha256hex(tar)}  public.tar.gz\n`,
  )
  const minisig = signLegacy(checksums)
  const artifacts = [
    { filename: 'jarvis-admin-linux-x64', data: bin },
    { filename: 'public.tar.gz', data: tar },
  ]

  it('allows a correctly signed release whose artifacts match', () => {
    expect(
      decideUpdateVerification({ publicKeyB64: pubB64, checksums, minisigContent: minisig, artifacts, allowUnsigned: false }),
    ).toEqual({ allow: true, signed: true })
  })

  it('refuses a release signed by a DIFFERENT key', () => {
    const other = makeMinisignKeypair()
    expect(
      decideUpdateVerification({ publicKeyB64: other.pubB64, checksums, minisigContent: minisig, artifacts, allowUnsigned: false }).allow,
    ).toBe(false)
  })

  it('refuses a hash mismatch even with a valid signature (tampered download)', () => {
    const tampered = [{ filename: 'jarvis-admin-linux-x64', data: Buffer.from('MALICIOUS') }, artifacts[1]]
    expect(
      decideUpdateVerification({ publicKeyB64: pubB64, checksums, minisigContent: minisig, artifacts: tampered, allowUnsigned: false }).allow,
    ).toBe(false)
  })

  it('refuses when a downloaded artifact is not listed in the signed checksums', () => {
    const extra = [...artifacts, { filename: 'surprise.bin', data: Buffer.from('x') }]
    expect(
      decideUpdateVerification({ publicKeyB64: pubB64, checksums, minisigContent: minisig, artifacts: extra, allowUnsigned: false }).allow,
    ).toBe(false)
  })

  it('the unsigned escape hatch does NOT override a BAD signature', () => {
    const other = makeMinisignKeypair()
    expect(
      decideUpdateVerification({ publicKeyB64: other.pubB64, checksums, minisigContent: minisig, artifacts, allowUnsigned: true }).allow,
    ).toBe(false)
  })

  it('the unsigned escape hatch does NOT override a hash mismatch', () => {
    const tampered = [{ filename: 'jarvis-admin-linux-x64', data: Buffer.from('X') }, artifacts[1]]
    expect(
      decideUpdateVerification({ publicKeyB64: pubB64, checksums, minisigContent: minisig, artifacts: tampered, allowUnsigned: true }).allow,
    ).toBe(false)
  })

  it('refuses an UNSIGNED release by default', () => {
    expect(
      decideUpdateVerification({ publicKeyB64: pubB64, checksums: null, minisigContent: null, artifacts, allowUnsigned: false }).allow,
    ).toBe(false)
  })

  it('allows an UNSIGNED release only with explicit opt-in', () => {
    expect(
      decideUpdateVerification({ publicKeyB64: pubB64, checksums: null, minisigContent: null, artifacts, allowUnsigned: true }),
    ).toMatchObject({ allow: true, signed: false })
  })

  it('treats a present checksums with a MISSING signature as unsigned', () => {
    expect(
      decideUpdateVerification({ publicKeyB64: pubB64, checksums, minisigContent: null, artifacts, allowUnsigned: false }).allow,
    ).toBe(false)
  })

  it('cross-checks against the real minisign fixtures (valid sig, unmatched hash → refuse)', () => {
    // Genuine fixture signature, but its checksums list dummy hashes, so no real
    // artifact can match — proving the signed-but-unmatched path is refused.
    expect(
      decideUpdateVerification({
        publicKeyB64: pubLine('signer.pub'),
        checksums: readLfBytes('checksums.txt'),
        minisigContent: readText('checksums.txt.minisig'),
        artifacts: [{ filename: 'jarvis-admin', data: Buffer.from('anything') }],
        allowUnsigned: true,
      }).allow,
    ).toBe(false)
  })
})
