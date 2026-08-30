export type VoiceAudioFailureCode =
  | 'invalid_audio'
  | 'recording_too_short'
  | 'recording_too_long'
  | 'recording_too_quiet'
  | 'recording_clipped'

export interface VoiceAudioMetrics {
  durationMs: number
  sampleRate: number
  rms: number
  activeRms: number
  peak: number
  clippingRatio: number
}

export interface VoiceAudioRequirements {
  minDurationMs: number
  maxDurationMs: number
  minRms: number
  maxClippingRatio?: number
}

export type VoiceAudioAssessment =
  | { ok: true; metrics: VoiceAudioMetrics }
  | { ok: false; code: VoiceAudioFailureCode; error: string; suggestion: string; metrics?: VoiceAudioMetrics }

function invalid(error: string): VoiceAudioAssessment {
  return {
    ok: false,
    code: 'invalid_audio',
    error,
    suggestion: 'Retry from the JARVIS microphone control using the selected physical microphone.',
  }
}

/** Inspect the 16-bit mono PCM WAV produced by the desktop capture pipeline. */
export function inspectVoiceWav(audio: Buffer): VoiceAudioMetrics | null {
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return null

  let format = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataSize = 0

  for (let offset = 12; offset + 8 <= audio.length;) {
    const chunkId = audio.toString('ascii', offset, offset + 4)
    const declaredSize = audio.readUInt32LE(offset + 4)
    const chunkOffset = offset + 8
    const availableSize = Math.min(declaredSize, Math.max(0, audio.length - chunkOffset))
    if (chunkId === 'fmt ' && availableSize >= 16) {
      format = audio.readUInt16LE(chunkOffset)
      channels = audio.readUInt16LE(chunkOffset + 2)
      sampleRate = audio.readUInt32LE(chunkOffset + 4)
      bitsPerSample = audio.readUInt16LE(chunkOffset + 14)
    } else if (chunkId === 'data') {
      dataOffset = chunkOffset
      dataSize = availableSize
      break
    }
    const next = chunkOffset + declaredSize + (declaredSize % 2)
    if (next <= offset || next > audio.length + 1) break
    offset = next
  }

  if (format !== 1 || channels !== 1 || bitsPerSample !== 16 || sampleRate < 8_000 || sampleRate > 96_000 || dataOffset < 0 || dataSize < 2) return null
  dataSize -= dataSize % 2
  const sampleCount = dataSize / 2
  let squareSum = 0
  let peak = 0
  let clipped = 0
  const frameSize = Math.max(160, Math.round(sampleRate * 0.02))
  const frameEnergy: number[] = []
  let frameSquare = 0
  let frameSamples = 0
  for (let offset = dataOffset; offset < dataOffset + dataSize; offset += 2) {
    const sample = audio.readInt16LE(offset) / 32768
    const absolute = Math.abs(sample)
    squareSum += sample * sample
    if (absolute > peak) peak = absolute
    if (absolute >= 0.995) clipped += 1
    frameSquare += sample * sample
    frameSamples += 1
    if (frameSamples >= frameSize) {
      frameEnergy.push(Math.sqrt(frameSquare / frameSamples))
      frameSquare = 0
      frameSamples = 0
    }
  }
  if (frameSamples > 0) frameEnergy.push(Math.sqrt(frameSquare / frameSamples))
  frameEnergy.sort((left, right) => right - left)
  const activeCount = Math.max(1, Math.ceil(frameEnergy.length * 0.2))
  const activeRms = frameEnergy.slice(0, activeCount).reduce((sum, value) => sum + value, 0) / activeCount

  return {
    durationMs: Math.round((sampleCount / sampleRate) * 1_000),
    sampleRate,
    rms: Math.sqrt(squareSum / Math.max(1, sampleCount)),
    activeRms,
    peak,
    clippingRatio: clipped / Math.max(1, sampleCount),
  }
}

export function assessVoiceWav(audio: Buffer, requirements: VoiceAudioRequirements): VoiceAudioAssessment {
  const metrics = inspectVoiceWav(audio)
  if (!metrics) return invalid('The microphone recording is not a valid mono PCM WAV file.')
  if (metrics.durationMs < requirements.minDurationMs) {
    return {
      ok: false,
      code: 'recording_too_short',
      error: `Recording is too short (${(metrics.durationMs / 1_000).toFixed(1)}s).`,
      suggestion: `Speak continuously for at least ${(requirements.minDurationMs / 1_000).toFixed(0)} seconds, then submit again.`,
      metrics,
    }
  }
  if (metrics.durationMs > requirements.maxDurationMs) {
    return {
      ok: false,
      code: 'recording_too_long',
      error: `Recording is too long (${(metrics.durationMs / 1_000).toFixed(1)}s).`,
      suggestion: `Use one natural phrase under ${(requirements.maxDurationMs / 1_000).toFixed(0)} seconds.`,
      metrics,
    }
  }
  if (metrics.activeRms < requirements.minRms || metrics.peak < 0.002) {
    return {
      ok: false,
      code: 'recording_too_quiet',
      error: 'Microphone signal is too quiet for reliable voice identity.',
      suggestion: 'Check the active Windows input device and microphone level, then speak at a normal conversational volume.',
      metrics,
    }
  }
  const maxClippingRatio = requirements.maxClippingRatio ?? 0.03
  if (metrics.clippingRatio > maxClippingRatio) {
    return {
      ok: false,
      code: 'recording_clipped',
      error: 'Microphone signal is distorted or clipping.',
      suggestion: 'Move slightly farther from the microphone and speak at a normal volume.',
      metrics,
    }
  }
  return { ok: true, metrics }
}
