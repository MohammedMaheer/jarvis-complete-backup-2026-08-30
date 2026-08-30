import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getWhisperModelPath,
  setWhisperModelPath,
  WHISPER_MODEL_PATH_KEY,
} from '../../src/services/whisper-model-setting.js'

// proxyRequest (used by the helper) calls global fetch, so we stub fetch and assert
// the exact gateway request the helper builds.
function fakeResponse(status: number, body: unknown) {
  return {
    status,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null),
      forEach: () => {},
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

const CFG = 'http://config:7700'
const JWT = 'Bearer superuser-jwt'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('getWhisperModelPath', () => {
  it('plucks whisper.model_path from the aggregated gateway response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(200, {
        services: [
          {
            service_name: 'jarvis-whisper-api',
            settings: [
              { key: 'whisper.allow_model_autodownload', value: false },
              { key: WHISPER_MODEL_PATH_KEY, value: '/whisper-models/ggml-large-v3-turbo.bin' },
            ],
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    expect(await getWhisperModelPath(CFG, JWT)).toBe('/whisper-models/ggml-large-v3-turbo.bin')
    // reads the aggregated endpoint filtered to the whisper service (no per-key GET exists)
    expect(fetchMock.mock.calls[0][0]).toBe(`${CFG}/v1/settings/?service=jarvis-whisper-api`)
  })

  it('returns null when the key is absent (falls back to compose/default)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(200, { services: [{ settings: [] }] })))
    expect(await getWhisperModelPath(CFG, JWT)).toBeNull()
  })

  it('returns null on a gateway error so the options screen still loads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(502, { detail: 'down' })))
    expect(await getWhisperModelPath(CFG, JWT)).toBeNull()
  })

  it('never calls the gateway without auth', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await getWhisperModelPath(CFG, undefined)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('setWhisperModelPath', () => {
  it('PUTs {value} to the per-key gateway endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, { success: true, requires_reload: true }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await setWhisperModelPath(CFG, JWT, '/whisper-models/ggml-small.en.bin')
    expect(res.ok).toBe(true)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${CFG}/v1/settings/jarvis-whisper-api/${WHISPER_MODEL_PATH_KEY}`)
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ value: '/whisper-models/ggml-small.en.bin' })
  })

  it('treats a 2xx success:false body as failure (gateway swallows downstream errors)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(200, { success: false, error: 'whisper unreachable' })))
    const res = await setWhisperModelPath(CFG, JWT, '/x.bin')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('whisper unreachable')
  })

  it('returns an error on a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(500, { detail: 'boom' })))
    expect((await setWhisperModelPath(CFG, JWT, '/x.bin')).ok).toBe(false)
  })
})
