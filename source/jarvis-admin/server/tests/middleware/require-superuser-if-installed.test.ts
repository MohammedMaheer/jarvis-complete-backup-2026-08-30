import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock only isInstalled; keep the rest of config.js real.
vi.mock('../../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../../src/config.js')>()
  return { ...actual, isInstalled: vi.fn() }
})

import { requireSuperuserIfInstalled } from '../../src/middleware/auth.js'
import { isInstalled } from '../../src/config.js'

const mockIsInstalled = isInstalled as unknown as ReturnType<typeof vi.fn>

function makeReply() {
  const reply = {
    statusCode: 0,
    payload: undefined as unknown,
    code(n: number) {
      reply.statusCode = n
      return reply
    },
    send(b: unknown) {
      reply.payload = b
      return reply
    },
  }
  return reply
}

function makeRequest(headers: Record<string, string> = {}) {
  return {
    headers,
    server: { config: { authUrl: 'http://fake-auth:7701' } },
    user: undefined as unknown,
  }
}

function superuserResponse(is_superuser: boolean) {
  return new Response(
    JSON.stringify({ id: 1, email: 'u@test.com', is_superuser }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('requireSuperuserIfInstalled', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('is a no-op during first-boot (not installed) — no auth, no auth-service call', async () => {
    mockIsInstalled.mockReturnValue(false)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const reply = makeReply()

    // No Authorization header at all — must still pass through.
    await requireSuperuserIfInstalled(makeRequest() as never, reply as never)

    expect(reply.statusCode).toBe(0) // nothing sent
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('requires a token once installed — 401 without one', async () => {
    mockIsInstalled.mockReturnValue(true)
    const reply = makeReply()

    await requireSuperuserIfInstalled(makeRequest() as never, reply as never)

    expect(reply.statusCode).toBe(401)
  })

  it('rejects a non-superuser once installed — 403', async () => {
    mockIsInstalled.mockReturnValue(true)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(superuserResponse(false))
    const reply = makeReply()

    await requireSuperuserIfInstalled(
      makeRequest({ authorization: 'Bearer regular' }) as never,
      reply as never,
    )

    expect(reply.statusCode).toBe(403)
  })

  it('allows a superuser once installed', async () => {
    mockIsInstalled.mockReturnValue(true)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(superuserResponse(true))
    const req = makeRequest({ authorization: 'Bearer good' })
    const reply = makeReply()

    await requireSuperuserIfInstalled(req as never, reply as never)

    expect(reply.statusCode).toBe(0) // nothing sent → passed the gate
    expect((req.user as { is_superuser: boolean }).is_superuser).toBe(true)
  })
})
