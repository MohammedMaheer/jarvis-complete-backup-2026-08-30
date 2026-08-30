import { describe, expect, it } from 'vitest'

import { assessVoiceWav, inspectVoiceWav } from '../../src/services/voice-audio-quality.js'

function pcmWav({ seconds = 4, sampleRate = 16_000, amplitude = 0.05 }: { seconds?: number; sampleRate?: number; amplitude?: number } = {}): Buffer {
  const sampleCount = Math.floor(seconds * sampleRate)
  const buffer = Buffer.alloc(44 + sampleCount * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + sampleCount * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(sampleCount * 2, 40)
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.sin((index / sampleRate) * Math.PI * 2 * 220) * amplitude
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * 2)
  }
  return buffer
}

function quietSpeechWithPauses(): Buffer {
  const sampleRate = 16_000
  const buffer = pcmWav({ seconds: 4, sampleRate, amplitude: 0 })
  for (let index = sampleRate; index < sampleRate * 2; index += 1) {
    const value = Math.sin((index / sampleRate) * Math.PI * 2 * 220) * 0.012
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * 2)
  }
  return buffer
}

const requirements = { minDurationMs: 3_000, maxDurationMs: 12_000, minRms: 0.006 }

describe('voice WAV quality assessment', () => {
  it('reports stable duration and level metrics for a valid capture', () => {
    const metrics = inspectVoiceWav(pcmWav())
    expect(metrics?.durationMs).toBe(4_000)
    expect(metrics?.sampleRate).toBe(16_000)
    expect(metrics?.rms).toBeGreaterThan(0.03)
  })

  it('rejects invalid, short, and silent captures with actionable codes', () => {
    expect(assessVoiceWav(Buffer.from('not wav'), requirements)).toMatchObject({ ok: false, code: 'invalid_audio' })
    expect(assessVoiceWav(pcmWav({ seconds: 1 }), requirements)).toMatchObject({ ok: false, code: 'recording_too_short' })
    expect(assessVoiceWav(pcmWav({ amplitude: 0 }), requirements)).toMatchObject({ ok: false, code: 'recording_too_quiet' })
  })

  it('accepts a clear challenge recording', () => {
    expect(assessVoiceWav(pcmWav({ seconds: 4.5, amplitude: 0.03 }), requirements)).toMatchObject({ ok: true })
  })

  it('measures active speech instead of rejecting a quiet phrase surrounded by pauses', () => {
    const metrics = inspectVoiceWav(quietSpeechWithPauses())
    expect(metrics?.rms).toBeLessThan(requirements.minRms)
    expect(metrics?.activeRms).toBeGreaterThan(requirements.minRms)
    expect(assessVoiceWav(quietSpeechWithPauses(), requirements)).toMatchObject({ ok: true })
  })
})
