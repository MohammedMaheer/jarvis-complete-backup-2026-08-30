import { apiClient } from './client'

export interface AuthUser {
  id: number
  email: string
  username?: string
  is_superuser: boolean
}

export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: 'bearer'
  user: AuthUser
}

export async function getSetupStatus(): Promise<{ needs_setup: boolean }> {
  const { data } = await apiClient.get<{ needs_setup: boolean }>('/api/auth/setup-status')
  return data
}

export async function setup(
  email: string,
  password: string,
  username?: string,
): Promise<TokenResponse> {
  const { data } = await apiClient.post<TokenResponse>('/api/auth/setup', {
    email,
    password,
    username,
  })
  return data
}

export async function login(email: string, password: string): Promise<TokenResponse> {
  const { data } = await apiClient.post<TokenResponse>('/api/auth/login', { email, password })
  return data
}

export async function refresh(refreshToken: string): Promise<TokenResponse> {
  const { data } = await apiClient.post<TokenResponse>('/api/auth/refresh', {
    refresh_token: refreshToken,
  })
  return data
}

export interface VoiceChallenge {
  challengeId: string
  phrase: string
  expiresAt: number
  enrolled: boolean
  sampleCount: number
}

export interface VoiceVerificationFailure {
  code?: 'invalid_audio' | 'recording_too_short' | 'recording_too_long' | 'recording_too_quiet' | 'recording_clipped' | 'speaker_mismatch' | 'phrase_mismatch' | 'voice_service_failure' | 'voice_service_unavailable'
  error?: string
  detail?: string
  retryable?: boolean
  suggestion?: string
  phraseMatched?: boolean
  confidence?: number
  transcript?: string
  missingAnchors?: string[]
  missingWords?: string[]
  matchedNonceWords?: number
  nonceWords?: number
}

export async function getVoiceChallenge(): Promise<VoiceChallenge> {
  const { data } = await apiClient.get<VoiceChallenge>('/api/auth/voice-challenge')
  return data
}

export async function verifyVoiceChallenge(audio: Blob, challengeId: string) {
  const { data } = await apiClient.post<{
    matched: boolean
    phraseMatched: boolean
    confidence: number
    transcript: string
    matchedNonceWords?: number
    nonceWords?: number
  }>(`/api/auth/voice-login?challenge_id=${encodeURIComponent(challengeId)}`, audio, {
    headers: { 'Content-Type': 'audio/wav' },
    timeout: 60_000,
  })
  return data
}
