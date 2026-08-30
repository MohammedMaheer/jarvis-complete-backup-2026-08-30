import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'
import type { DockerService, ContainerInfo, ContainerStats } from '../../src/services/docker.js'
import { mockSuperuserAuth } from '../helpers.js'

function createMockDocker(containers: ContainerInfo[] = []): DockerService {
  return {
    isAvailable: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    listJarvisContainers: vi.fn<() => Promise<ContainerInfo[]>>().mockResolvedValue(containers),
    getContainerStatus: vi.fn<(id: string) => Promise<ContainerInfo | null>>().mockImplementation(
      async (id: string) => containers.find((c) => c.id === id) ?? null,
    ),
    restartContainer: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    getContainerStats: vi.fn<(id: string) => Promise<ContainerStats | null>>().mockResolvedValue({
      cpuPercent: 2.5,
      memoryUsageMb: 128,
      memoryLimitMb: 1024,
      memoryPercent: 12.5,
    }),
  }
}

const sampleContainers: ContainerInfo[] = [
  {
    id: 'abc123',
    name: 'jarvis-auth',
    image: 'jarvis-auth:latest',
    state: 'running',
    status: 'Up 2 hours',
    ports: [{ private: 7701, public: 7701 }],
    labels: { 'com.jarvis.managed': 'true' },
    created: '2024-01-01T00:00:00Z',
  },
  {
    id: 'def456',
    name: 'jarvis-logs',
    image: 'jarvis-logs:latest',
    state: 'running',
    status: 'Up 2 hours',
    ports: [{ private: 7702, public: 7702 }],
    labels: {},
    created: '2024-01-01T00:00:00Z',
  },
]

describe('container routes', () => {
  let app: FastifyInstance
  let mockDocker: DockerService

  beforeAll(async () => {
    mockDocker = createMockDocker(sampleContainers)
    app = await buildApp({
      config: { authUrl: 'http://fake-auth:7701' },
      docker: mockDocker,
    })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    // Re-mock docker methods since restoreAllMocks clears them
    ;(mockDocker.listJarvisContainers as ReturnType<typeof vi.fn>).mockResolvedValue(sampleContainers)
    ;(mockDocker.getContainerStatus as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string) => sampleContainers.find((c) => c.id === id) ?? null,
    )
    ;(mockDocker.getContainerStats as ReturnType<typeof vi.fn>).mockResolvedValue({
      cpuPercent: 2.5, memoryUsageMb: 128, memoryLimitMb: 1024, memoryPercent: 12.5,
    })
    ;(mockDocker.restartContainer as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  })

  describe('GET /api/containers', () => {
    it('returns list of containers', async () => {
      mockSuperuserAuth()
      const res = await app.inject({
        method: 'GET',
        url: '/api/containers',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.containers).toHaveLength(2)
      expect(body.containers[0].name).toBe('jarvis-auth')
    })
  })

  describe('GET /api/containers/:id', () => {
    it('returns single container with stats', async () => {
      mockSuperuserAuth()
      const res = await app.inject({
        method: 'GET',
        url: '/api/containers/abc123',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.container.id).toBe('abc123')
      expect(body.stats.cpuPercent).toBe(2.5)
    })

    it('returns 404 for unknown container', async () => {
      mockSuperuserAuth()
      ;(mockDocker.getContainerStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)

      const res = await app.inject({
        method: 'GET',
        url: '/api/containers/unknown',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(404)
    })
  })

  describe('POST /api/containers/:id/restart', () => {
    it('restarts a container', async () => {
      mockSuperuserAuth()
      const res = await app.inject({
        method: 'POST',
        url: '/api/containers/abc123/restart',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().success).toBe(true)
      expect(mockDocker.restartContainer).toHaveBeenCalledWith('abc123')
    })
  })
})

describe('container routes without Docker', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp({
      config: { authUrl: 'http://fake-auth:7701' },
      // No docker service
    })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns 503 when Docker is unavailable', async () => {
    mockSuperuserAuth()
    const res = await app.inject({
      method: 'GET',
      url: '/api/containers',
      headers: { authorization: 'Bearer valid-token' },
    })

    expect(res.statusCode).toBe(503)
    expect(res.json().error).toMatch(/not available/i)
  })
})
