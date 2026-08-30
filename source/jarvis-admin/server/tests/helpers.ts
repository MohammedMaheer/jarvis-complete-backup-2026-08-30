import { vi } from 'vitest'

/**
 * Mock the requireSuperuser middleware's fetch to /auth/me.
 * Must be called before each request to a protected route.
 * Adds one mockResolvedValueOnce to the global fetch spy.
 */
export function mockSuperuserAuth(): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(
      JSON.stringify({ id: 1, email: 'admin@test.com', is_superuser: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  )
}

/**
 * Create a mock Response returning JSON with the given status.
 */
export function mockFetchJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Create a mock Response returning plain text with the given status.
 */
export function mockFetchText(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain' },
  })
}

/**
 * Make the next fetch call reject with a network error.
 */
export function mockFetchError(message = 'fetch failed'): void {
  vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError(message))
}
