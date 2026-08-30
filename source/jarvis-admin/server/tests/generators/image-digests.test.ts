import { describe, it, expect } from 'vitest'
import { pinnedOrTaggedImage } from '../../src/services/generators/compose-generator.js'

describe('pinnedOrTaggedImage', () => {
  // repo -> full tag (track+suffix) -> digest
  const digests = {
    'jarvis-command-center': { latest: 'sha256:aaaa', dev: 'sha256:bbbb' },
    'jarvis-whisper-api': { latest: 'sha256:cccc', 'latest-cuda': 'sha256:dddd' }, // cpu = plain tag
    'jarvis-llm-proxy-api': { 'latest-cpu': 'sha256:eeee' }, // llm-proxy has no bare latest
  }
  const cc = 'ghcr.io/alexberardi/jarvis-command-center'
  const whisper = 'ghcr.io/alexberardi/jarvis-whisper-api'

  it('pins by @digest when one exists for (repo, track+suffix)', () => {
    expect(pinnedOrTaggedImage(cc, 'latest', '', digests, true)).toBe(`${cc}@sha256:aaaa`)
  })

  it('NEVER pins the dev track — dev exists to run the freshest CI-built images', () => {
    // mirrors jarvis-installer#17: even with a recorded dev digest, dev floats
    expect(pinnedOrTaggedImage(cc, 'dev', '', digests, true)).toBe(`${cc}:\${JARVIS_IMAGE_TAG:-latest}`)
  })

  it('pins the variant digest via the suffix, and whisper-cpu via the plain tag', () => {
    expect(pinnedOrTaggedImage(whisper, 'latest', '-cuda', digests, true)).toBe(`${whisper}@sha256:dddd`)
    expect(pinnedOrTaggedImage(whisper, 'latest', '', digests, true)).toBe(`${whisper}@sha256:cccc`)
  })

  it('falls back to the floating tag when no digest is recorded', () => {
    // dev-cuda not in the map
    expect(pinnedOrTaggedImage(whisper, 'dev', '-cuda', digests))
      .toBe(`${whisper}:\${JARVIS_IMAGE_TAG:-latest}-cuda`)
    // repo entirely absent
    expect(pinnedOrTaggedImage('ghcr.io/alexberardi/jarvis-tts', 'latest', '', digests))
      .toBe('ghcr.io/alexberardi/jarvis-tts:${JARVIS_IMAGE_TAG:-latest}')
  })

  it('fallback preserves the exact ${JARVIS_IMAGE_TAG} interpolation + suffix (empty map)', () => {
    expect(pinnedOrTaggedImage('ghcr.io/alexberardi/jarvis-llm-proxy-api', 'latest', '-vulkan', {}))
      .toBe('ghcr.io/alexberardi/jarvis-llm-proxy-api:${JARVIS_IMAGE_TAG:-latest}-vulkan')
  })
})
