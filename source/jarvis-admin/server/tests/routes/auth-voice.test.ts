import { describe, expect, it } from 'vitest'

import { isVerifiedPrimarySpeaker, matchChallengePhrase } from '../../src/routes/auth.js'

describe('voice challenge matching', () => {
  it('requires the operator anchors and two nonce words', () => {
    const result = matchChallengePhrase('Jarvis authenticate Maheer cobalt vector vision', 'Jarvus authentic Maheer cobalt vector')
    expect(result.matched).toBe(true)
    expect(result.matchedNonceWords).toBe(2)
    expect(result.nonceWords).toBe(3)
  })

  it('tolerates one-character Whisper substitutions in nonce words', () => {
    const result = matchChallengePhrase('Jarvis authenticate Maheer quantum orbit falcon', 'Jarvis authenticate Mahir quantun orbit')
    expect(result.matched).toBe(true)
    expect(result.missingWords).toEqual(['falcon'])
  })

  it('accepts the common split-name transcription and nonce homophones', () => {
    const result = matchChallengePhrase(
      'Jarvis authenticate Maheer arc stark vision',
      'Jervis authentication me here ark start vision',
    )
    expect(result.matched).toBe(true)
    expect(result.missingAnchors).toEqual([])
    expect(result.missingWords).toEqual([])
  })

  it('does not accept a phrase without all anchors', () => {
    const result = matchChallengePhrase('Jarvis authenticate Maheer cobalt vector vision', 'Jarvis authenticate cobalt vector vision')
    expect(result.matched).toBe(false)
    expect(result.missingAnchors).toEqual(['maheer'])
  })
})

describe('primary speaker verification boundary', () => {
  it('trusts an upstream-calibrated primary-speaker match without a conflicting fixed threshold', () => {
    expect(isVerifiedPrimarySpeaker(1, 0.349, 1)).toBe(true)
    expect(isVerifiedPrimarySpeaker('1', '0.407', 1)).toBe(true)
  })

  it('rejects unknown, wrong, or zero-confidence speakers', () => {
    expect(isVerifiedPrimarySpeaker(null, 0.8, 1)).toBe(false)
    expect(isVerifiedPrimarySpeaker(2, 0.8, 1)).toBe(false)
    expect(isVerifiedPrimarySpeaker(1, 0, 1)).toBe(false)
  })
})
