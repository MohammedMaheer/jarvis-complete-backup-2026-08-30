import type { FastifyInstance } from 'fastify'
import { randomInt, randomUUID } from 'node:crypto'
import { proxyRequest } from '../services/proxy.js'
import { assessVoiceWav } from '../services/voice-audio-quality.js'

const WHISPER_URL = process.env.JARVIS_WHISPER_URL ?? 'http://127.0.0.1:7706'
const HOUSEHOLD_ID = process.env.JARVIS_PRIMARY_HOUSEHOLD_ID ?? ''
const PRIMARY_USER_ID = Number.parseInt(process.env.JARVIS_PRIMARY_USER_ID ?? '1', 10)
const CHALLENGE_TTL_MS = 2 * 60 * 1000
const VOICE_LOGIN_AUDIO_REQUIREMENTS = {
  minDurationMs: 2_500,
  maxDurationMs: 12_000,
  minRms: 0.002,
  maxClippingRatio: 0.03,
} as const
const challengeWords = [
  // Common, phonetically distinct English words keep the local base Whisper
  // model accurate without reducing nonce entropy or bypassing voice identity.
  'blue', 'copper', 'delta', 'falcon', 'garden', 'matrix', 'piano', 'planet',
  'rocket', 'seven', 'silver', 'system', 'tiger', 'vector', 'vision', 'winter',
]
const voiceChallenges = new Map<string, { phrase: string; expiresAt: number }>()

function appHeaders(): Record<string, string> | null {
  const appId = process.env.JARVIS_APP_ID_COMMAND_CENTER
  const appKey = process.env.JARVIS_APP_KEY_COMMAND_CENTER
  if (!appId || !appKey || !HOUSEHOLD_ID) return null
  return {
    'X-Jarvis-App-Id': appId,
    'X-Jarvis-App-Key': appKey,
    'X-Context-Household-Id': HOUSEHOLD_ID,
    'X-Context-Node-Id': 'maheer-desktop',
    'X-Context-Household-Member-Ids': String(PRIMARY_USER_ID),
  }
}

function normalizedTokens(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
}

function normalizedWords(value: string, includeJoinedPhrases = false): Set<string> {
  const tokens = normalizedTokens(value)
  const words = new Set(tokens)
  if (includeJoinedPhrases) {
    // Whisper commonly renders a name such as "Maheer" as two words (for
    // example "me here" or "my here"). Include adjacent compounds only on
    // the heard side so the expected challenge token list remains unchanged.
    for (let index = 0; index < tokens.length - 1; index += 1) {
      words.add(`${tokens[index]}${tokens[index + 1]}`)
    }
  }
  return words
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      )
    }
    for (let column = 0; column <= right.length; column += 1) previous[column] = current[column]
  }
  return previous[right.length]
}

function tokenMatches(expected: string, heard: Set<string>, aliases: string[] = []): boolean {
  const candidates = [expected, ...aliases]
  for (const candidate of candidates) {
    for (const token of heard) {
      if (token === candidate) return true
      // Whisper can drop a suffix ("authenticate" → "authentic") or make a
      // one-character phonetic substitution. Keep short nonce words exact;
      // fuzzy matching is only for the longer challenge anchors/tokens.
      if (candidate.length >= 6 && (token.startsWith(candidate.slice(0, -2)) || editDistance(candidate, token) <= 1)) return true
    }
  }
  return false
}

const operatorNameAliases: Record<string, string[]> = {
  maheer: ['maheer', 'mahir', 'maher', 'mohir', 'mehere', 'myhere', 'myhair'],
}

const challengeAnchorAliases: Record<string, string[]> = {
  jarvis: ['jarvus', 'jarvies', 'jervis', 'javis'],
  authenticate: ['authentic', 'authentication', 'authenticated', 'authorize', 'authorise', 'verify'],
}

const challengeWordAliases: Record<string, string[]> = {
  arc: ['ark'],
  aurora: ['arora'],
  cobalt: ['kobold'],
  helios: ['helius'],
  neural: ['neuron'],
  quantum: ['quantam'],
  seven: ['7'],
  stark: ['start'],
}

/**
 * Whisper occasionally renders the operator name or one challenge token with
 * a nearby spelling. Keep the two-factor gate strong (all anchors plus two of
 * three nonce words) while avoiding false rejects caused by a single ASR
 * phonetic variation. The speaker encoder remains an independent requirement.
 */
export function matchChallengePhrase(phrase: string, transcript: string): {
  matched: boolean
  missingAnchors: string[]
  missingWords: string[]
  matchedNonceWords: number
  nonceWords: number
} {
  const heard = normalizedWords(transcript, true)
  const expected = [...normalizedWords(phrase)]
  const anchors = ['jarvis', 'authenticate', 'maheer']
  const missingAnchors = anchors.filter((word) => {
    const aliases = [...(operatorNameAliases[word] ?? []), ...(challengeAnchorAliases[word] ?? [])]
    return !tokenMatches(word, heard, aliases)
  })
  const nonceWords = expected.filter((word) => !anchors.includes(word))
  const matchedNonceWords = nonceWords.filter((word) => tokenMatches(word, heard, challengeWordAliases[word] ?? [])).length
  const requiredNonceWords = Math.max(1, nonceWords.length - 1)
  const missingWords = nonceWords.filter((word) => !tokenMatches(word, heard, challengeWordAliases[word] ?? []))
  return {
    matched: missingAnchors.length === 0 && matchedNonceWords >= requiredNonceWords,
    missingAnchors,
    missingWords,
    matchedNonceWords,
    nonceWords: nonceWords.length,
  }
}

/**
 * Whisper returns a user_id only after its encoder-specific, duration-aware
 * threshold and household ambiguity checks pass. Do not apply a second fixed
 * threshold here: doing so silently overrides the calibrated voice service
 * and rejects identities that Whisper has already verified.
 */
export function isVerifiedPrimarySpeaker(userId: unknown, confidenceValue: unknown, primaryUserId: number): boolean {
  const normalizedUserId = Number(userId)
  const confidence = Number(confidenceValue)
  return Number.isFinite(normalizedUserId)
    && normalizedUserId === primaryUserId
    && Number.isFinite(confidence)
    && confidence > 0
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/voice-challenge', async (_request, reply) => {
    const headers = appHeaders()
    if (!headers) {
      reply.code(503).send({ error: 'Local voice identity is not configured', enrolled: false })
      return
    }

    let enrolled = false
    let sampleCount = 0
    try {
      const check = await fetch(`${WHISPER_URL}/voice-profiles/check?user_id=${PRIMARY_USER_ID}&household_id=${encodeURIComponent(HOUSEHOLD_ID)}`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      })
      if (check.ok) {
        const payload = await check.json() as { exists?: boolean; sample_count?: number }
        enrolled = payload.exists === true
        sampleCount = payload.sample_count ?? 0
      }
    } catch {
      // The credential fallback remains available while Whisper is offline.
    }

    const picked = new Set<string>()
    while (picked.size < 3) picked.add(challengeWords[randomInt(challengeWords.length)])
    const phrase = `Jarvis authenticate Maheer ${[...picked].join(' ')}`
    const challengeId = randomUUID()
    voiceChallenges.set(challengeId, { phrase, expiresAt: Date.now() + CHALLENGE_TTL_MS })
    for (const [id, challenge] of voiceChallenges) {
      if (challenge.expiresAt < Date.now()) voiceChallenges.delete(id)
    }
    reply.send({ challengeId, phrase, expiresAt: Date.now() + CHALLENGE_TTL_MS, enrolled, sampleCount })
  })

  app.post<{ Querystring: { challenge_id?: string }; Body: Buffer }>('/voice-login', async (request, reply) => {
    const challengeId = request.query.challenge_id
    const challenge = challengeId ? voiceChallenges.get(challengeId) : undefined
    if (!challenge || challenge.expiresAt < Date.now()) {
      if (challengeId) voiceChallenges.delete(challengeId)
      reply.code(401).send({ error: 'Voice challenge expired. Request a new phrase.' })
      return
    }
    const audio = request.body
    if (!Buffer.isBuffer(audio) || audio.length < 4_000 || audio.length > 2_000_000) {
      reply.code(400).send({
        code: 'invalid_audio',
        error: 'A clear WAV recording under 2 MB is required',
        retryable: true,
        suggestion: 'Retry the same challenge using the JARVIS microphone control.',
      })
      return
    }
    const audioAssessment = assessVoiceWav(audio, VOICE_LOGIN_AUDIO_REQUIREMENTS)
    if (!audioAssessment.ok) {
      request.log.warn({
        failureCode: audioAssessment.code,
        durationMs: audioAssessment.metrics?.durationMs,
        rms: audioAssessment.metrics ? Number(audioAssessment.metrics.rms.toFixed(4)) : undefined,
        clippingRatio: audioAssessment.metrics ? Number(audioAssessment.metrics.clippingRatio.toFixed(4)) : undefined,
      }, 'Voice login capture rejected before biometric processing')
      reply.code(400).send({ ...audioAssessment, retryable: true })
      return
    }
    const headers = appHeaders()
    if (!headers) {
      reply.code(503).send({ error: 'Local voice identity is not configured' })
      return
    }

    // Consume a challenge only after the local capture has passed validation.
    // A too-short/quiet clip can therefore be retried without rotating it.
    voiceChallenges.delete(challengeId!)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'voice-unlock.wav')
    try {
      const response = await fetch(`${WHISPER_URL}/transcribe?preprocess=true&speaker_recognition=true`, {
        method: 'POST', headers, body: form, signal: AbortSignal.timeout(60_000),
      })
      const payload = await response.json() as {
        text?: string
        speaker?: { user_id?: number | null; confidence?: number }
        detail?: string
      }
      if (!response.ok) {
        reply.code(502).send({
          code: 'voice_service_failure',
          error: payload.detail ?? 'Voice identity service failed',
          retryable: true,
          suggestion: 'Wait a moment, rotate the challenge, and retry.',
        })
        return
      }

      const phraseResult = matchChallengePhrase(challenge.phrase, payload.text ?? '')
      const phraseMatched = phraseResult.matched
      // JSON clients/proxies occasionally serialize numeric speaker IDs and
      // confidence values as strings. Normalize them at this boundary so a
      // verified local voiceprint is not rejected solely due to wire typing.
      const confidence = Number(payload.speaker?.confidence ?? 0)
      const speakerMatched = isVerifiedPrimarySpeaker(payload.speaker?.user_id, payload.speaker?.confidence, PRIMARY_USER_ID)
      if (!phraseMatched || !speakerMatched) {
        const failureCode = !speakerMatched ? 'speaker_mismatch' : 'phrase_mismatch'
        const suggestion = !speakerMatched
          ? 'Check the active Windows microphone level, speak naturally for 3-5 seconds, and retry the new challenge.'
          : `Repeat the complete displayed phrase${[...phraseResult.missingAnchors, ...phraseResult.missingWords].length ? `, especially: ${[...phraseResult.missingAnchors, ...phraseResult.missingWords].join(', ')}` : ''}.`
        request.log.warn({
          failureCode,
          phraseMatched,
          confidence: Number(confidence.toFixed(3)),
          missingAnchors: phraseResult.missingAnchors,
          missingWords: phraseResult.missingWords,
          matchedNonceWords: phraseResult.matchedNonceWords,
          nonceWords: phraseResult.nonceWords,
          durationMs: audioAssessment.metrics.durationMs,
          rms: Number(audioAssessment.metrics.rms.toFixed(4)),
        }, 'Voice login rejected')
        reply.code(401).send({
          code: failureCode,
          error: !speakerMatched ? 'Voiceprint did not match the primary operator' : 'Challenge phrase was not heard correctly',
          retryable: true,
          suggestion,
          matched: false,
          phraseMatched,
          confidence,
          transcript: payload.text ?? '',
          missingAnchors: phraseResult.missingAnchors,
          missingWords: phraseResult.missingWords,
          matchedNonceWords: phraseResult.matchedNonceWords,
          nonceWords: phraseResult.nonceWords,
        })
        return
      }
      request.log.info({
        confidence: Number(confidence.toFixed(3)),
        durationMs: audioAssessment.metrics.durationMs,
        rms: Number(audioAssessment.metrics.rms.toFixed(4)),
      }, 'Voice login accepted')
      reply.send({ matched: true, phraseMatched: true, confidence, transcript: payload.text ?? '', matchedNonceWords: phraseResult.matchedNonceWords, nonceWords: phraseResult.nonceWords })
    } catch (error) {
      reply.code(503).send({
        code: 'voice_service_unavailable',
        error: `Local voice identity is unavailable: ${(error as Error).message}`,
        retryable: true,
        suggestion: 'Use recovery credentials or retry after the local voice service is ready.',
      })
    }
  })

  app.get('/setup-status', async (_request, reply) => {
    const result = await proxyRequest({
      method: 'GET',
      url: `${app.config.authUrl}/auth/setup-status`,
      timeout: 5_000,
    })
    reply.code(result.status).send(result.data)
  })

  app.post('/setup', async (request, reply) => {
    const result = await proxyRequest({
      method: 'POST',
      url: `${app.config.authUrl}/auth/setup`,
      body: request.body,
      timeout: 10_000,
    })
    reply.code(result.status).send(result.data)
  })

  app.post('/login', async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string }
    const authUrl = app.config.authUrl

    const result = await proxyRequest({
      method: 'POST',
      url: `${authUrl}/auth/login`,
      body: { email, password },
      timeout: 10_000,
    })

    reply.code(result.status).send(result.data)
  })

  app.post('/refresh', async (request, reply) => {
    const { refresh_token } = request.body as { refresh_token: string }
    const authUrl = app.config.authUrl

    const result = await proxyRequest({
      method: 'POST',
      url: `${authUrl}/auth/refresh`,
      body: { refresh_token },
      timeout: 10_000,
    })

    reply.code(result.status).send(result.data)
  })
}
