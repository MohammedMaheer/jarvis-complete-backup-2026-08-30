import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import * as authApi from '@/api/auth'
import { setAuthToken, setLogoutFunction, setRefreshFunction } from '@/api/client'
import type { AuthUser } from '@/api/auth'

interface AuthState {
  user: AuthUser | null
  accessToken: string | null
  refreshToken: string | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
}

interface AuthContextValue {
  state: AuthState
  login: (email: string, password: string) => Promise<void>
  voiceUnlock: (audio: Blob, challengeId: string) => Promise<number>
  setup: (email: string, password: string, username?: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

const ACCESS_KEY = 'jarvis-admin:access_token'
const REFRESH_KEY = 'jarvis-admin:refresh_token'
const USER_KEY = 'jarvis-admin:user'
// A local-only pairing survives an explicit UI logout so the operator can
// unlock with the enrolled voiceprint on the next launch. It is still a
// rotating auth refresh token; the voice challenge is required before it is
// promoted back into the active session.
const PAIRED_REFRESH_KEY = 'jarvis-admin:paired_refresh_token'
const PAIRED_USER_KEY = 'jarvis-admin:paired_user'
const UNLOCK_KEY = 'jarvis-admin:session-unlocked'

const REFRESH_INTERVAL_MS = 10 * 60 * 1000

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    const storedAccess = localStorage.getItem(ACCESS_KEY)
    const storedRefresh = localStorage.getItem(REFRESH_KEY)
    const storedUser = localStorage.getItem(USER_KEY)

    if (storedAccess && storedRefresh && storedUser && sessionStorage.getItem(UNLOCK_KEY) === '1') {
      try {
        const user = JSON.parse(storedUser) as AuthUser
        setAuthToken(storedAccess)
        return {
          user,
          accessToken: storedAccess,
          refreshToken: storedRefresh,
          isAuthenticated: true,
          isLoading: false,
          error: null,
        }
      } catch {
        // Corrupted stored data — fall through to defaults
      }
    }

    return {
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    }
  })

  const logout = useCallback(() => {
    localStorage.removeItem(ACCESS_KEY)
    localStorage.removeItem(REFRESH_KEY)
    localStorage.removeItem(USER_KEY)
    sessionStorage.removeItem(UNLOCK_KEY)
    setAuthToken(null)
    setState({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    })
  }, [])

  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    const storedRefresh = localStorage.getItem(REFRESH_KEY)
    if (!storedRefresh) return null

    try {
      const res = await authApi.refresh(storedRefresh)
      const newAccess = res.access_token
      const newRefresh = res.refresh_token ?? storedRefresh

      localStorage.setItem(ACCESS_KEY, newAccess)
      localStorage.setItem(REFRESH_KEY, newRefresh)
      localStorage.setItem(PAIRED_REFRESH_KEY, newRefresh)
      setAuthToken(newAccess)

      setState((prev) => ({
        ...prev,
        accessToken: newAccess,
        refreshToken: newRefresh,
      }))

      return newAccess
    } catch {
      logout()
      return null
    }
  }, [logout])

  // Register refresh/logout functions with the axios interceptor
  useEffect(() => {
    setRefreshFunction(refreshAccessToken)
    setLogoutFunction(logout)
  }, [refreshAccessToken, logout])

  // Periodic token refresh
  useEffect(() => {
    if (!state.isAuthenticated) return
    const timer = setInterval(() => {
      refreshAccessToken()
    }, REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [state.isAuthenticated, refreshAccessToken])

  const login = useCallback(async (email: string, password: string) => {
    setState((prev) => ({ ...prev, error: null, isLoading: true }))

    try {
      const res = await authApi.login(email, password)

      // UX gate only — the real security boundary is server-side
      if (!res.user.is_superuser) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: 'Admin access required. This account is not a superuser.',
        }))
        return
      }

      localStorage.setItem(ACCESS_KEY, res.access_token)
      localStorage.setItem(REFRESH_KEY, res.refresh_token)
      localStorage.setItem(USER_KEY, JSON.stringify(res.user))
      localStorage.setItem(PAIRED_REFRESH_KEY, res.refresh_token)
      localStorage.setItem(PAIRED_USER_KEY, JSON.stringify(res.user))
      sessionStorage.setItem(UNLOCK_KEY, '1')
      setAuthToken(res.access_token)

      setState({
        user: res.user,
        accessToken: res.access_token,
        refreshToken: res.refresh_token,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        'Login failed'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [])

  const voiceUnlock = useCallback(async (audio: Blob, challengeId: string): Promise<number> => {
    setState((prev) => ({ ...prev, error: null, isLoading: true }))
    try {
      const verification = await authApi.verifyVoiceChallenge(audio, challengeId)
      const storedRefresh = localStorage.getItem(REFRESH_KEY) ?? localStorage.getItem(PAIRED_REFRESH_KEY)
      const storedUser = localStorage.getItem(USER_KEY) ?? localStorage.getItem(PAIRED_USER_KEY)
      if (!storedRefresh || !storedUser) throw new Error('Use credentials once to pair this desktop before voice unlock.')
      const res = await authApi.refresh(storedRefresh)
      const user = res.user ?? JSON.parse(storedUser) as AuthUser
      if (!user.is_superuser) throw new Error('Administrator voice identity required.')
      localStorage.setItem(ACCESS_KEY, res.access_token)
      const nextRefresh = res.refresh_token ?? storedRefresh
      localStorage.setItem(REFRESH_KEY, nextRefresh)
      localStorage.setItem(USER_KEY, JSON.stringify(user))
      localStorage.setItem(PAIRED_REFRESH_KEY, nextRefresh)
      localStorage.setItem(PAIRED_USER_KEY, JSON.stringify(user))
      sessionStorage.setItem(UNLOCK_KEY, '1')
      setAuthToken(res.access_token)
      setState({ user, accessToken: res.access_token, refreshToken: res.refresh_token ?? storedRefresh, isAuthenticated: true, isLoading: false, error: null })
      return verification.confidence
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { error?: string; detail?: string } }; message?: string })?.response?.data?.error
        ?? (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? (err as Error)?.message
        ?? 'Voice identity failed'
      setState((prev) => ({ ...prev, isLoading: false, error: message }))
      throw err
    }
  }, [])

  const setup = useCallback(async (email: string, password: string, username?: string) => {
    setState((prev) => ({ ...prev, error: null, isLoading: true }))

    try {
      const res = await authApi.setup(email, password, username)

      localStorage.setItem(ACCESS_KEY, res.access_token)
      localStorage.setItem(REFRESH_KEY, res.refresh_token)
      localStorage.setItem(USER_KEY, JSON.stringify(res.user))
      localStorage.setItem(PAIRED_REFRESH_KEY, res.refresh_token)
      localStorage.setItem(PAIRED_USER_KEY, JSON.stringify(res.user))
      sessionStorage.setItem(UNLOCK_KEY, '1')
      setAuthToken(res.access_token)

      setState({
        user: res.user,
        accessToken: res.access_token,
        refreshToken: res.refresh_token,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        'Setup failed'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [])

  const value = useMemo(() => ({ state, login, voiceUnlock, setup, logout }), [state, login, voiceUnlock, setup, logout])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
