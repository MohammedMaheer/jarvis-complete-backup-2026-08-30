import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dockerode before importing the module under test
const mockPing = vi.fn()
const mockListContainers = vi.fn()
const mockGetContainer = vi.fn()

vi.mock('dockerode', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      ping: mockPing,
      listContainers: mockListContainers,
      getContainer: mockGetContainer,
    })),
  }
})

import { createDockerService } from '../../src/services/docker.js'

describe('createDockerService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when Docker is unavailable', async () => {
    mockPing.mockRejectedValueOnce(new Error('ENOENT'))

    const service = await createDockerService('/var/run/docker.sock')
    expect(service).toBeNull()
  })

  it('returns a service when Docker is available', async () => {
    mockPing.mockResolvedValueOnce('OK')

    const service = await createDockerService('/var/run/docker.sock')
    expect(service).not.toBeNull()
  })
})

describe('DockerService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Make Docker available by default
    mockPing.mockResolvedValue('OK')
  })

  it('lists only jarvis- prefixed containers', async () => {
    mockListContainers.mockResolvedValueOnce([
      {
        Id: 'aaa',
        Names: ['/jarvis-auth'],
        Image: 'jarvis-auth:latest',
        State: 'running',
        Status: 'Up 1h',
        Ports: [{ PrivatePort: 7701, PublicPort: 7701 }],
        Labels: {},
        Created: 1704067200,
      },
      {
        Id: 'bbb',
        Names: ['/postgres'],
        Image: 'postgres:16',
        State: 'running',
        Status: 'Up 2h',
        Ports: [{ PrivatePort: 5432 }],
        Labels: {},
        Created: 1704067200,
      },
    ])

    const service = await createDockerService('/var/run/docker.sock')
    const containers = await service!.listJarvisContainers()

    expect(containers).toHaveLength(1)
    expect(containers[0].name).toBe('jarvis-auth')
  })

  it('includes containers with com.jarvis.managed label', async () => {
    mockListContainers.mockResolvedValueOnce([
      {
        Id: 'ccc',
        Names: ['/custom-name'],
        Image: 'custom:latest',
        State: 'running',
        Status: 'Up 1h',
        Ports: [],
        Labels: { 'com.jarvis.managed': 'true' },
        Created: 1704067200,
      },
    ])

    const service = await createDockerService('/var/run/docker.sock')
    const containers = await service!.listJarvisContainers()

    expect(containers).toHaveLength(1)
    expect(containers[0].name).toBe('custom-name')
  })

  it('returns null for unknown container status', async () => {
    const mockInspect = vi.fn().mockRejectedValueOnce(new Error('not found'))
    mockGetContainer.mockReturnValueOnce({ inspect: mockInspect })

    const service = await createDockerService('/var/run/docker.sock')
    const status = await service!.getContainerStatus('unknown-id')

    expect(status).toBeNull()
  })

  it('returns container info from getContainerStatus', async () => {
    const mockInspect = vi.fn().mockResolvedValueOnce({
      Id: 'abc123',
      Name: '/jarvis-auth',
      Config: { Image: 'jarvis-auth:latest', Labels: { env: 'dev' } },
      State: { Status: 'running' },
      NetworkSettings: {
        Ports: {
          '7701/tcp': [{ HostPort: '7701' }],
        },
      },
      Created: '2024-01-01T00:00:00Z',
    })
    mockGetContainer.mockReturnValueOnce({ inspect: mockInspect })

    const service = await createDockerService('/var/run/docker.sock')
    const info = await service!.getContainerStatus('abc123')

    expect(info).not.toBeNull()
    expect(info!.name).toBe('jarvis-auth')
    expect(info!.state).toBe('running')
    expect(info!.ports[0]).toEqual({ private: 7701, public: 7701 })
  })

  it('restarts a container', async () => {
    const mockRestart = vi.fn().mockResolvedValueOnce(undefined)
    mockGetContainer.mockReturnValueOnce({ restart: mockRestart })

    const service = await createDockerService('/var/run/docker.sock')
    await service!.restartContainer('abc123')

    expect(mockRestart).toHaveBeenCalledWith({ t: 10 })
  })

  it('calculates CPU percentage from stats', async () => {
    const mockStats = vi.fn().mockResolvedValueOnce({
      cpu_stats: {
        cpu_usage: { total_usage: 200_000_000 },
        system_cpu_usage: 1_000_000_000,
        online_cpus: 4,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 100_000_000 },
        system_cpu_usage: 500_000_000,
      },
      memory_stats: {
        usage: 134_217_728, // 128 MB
        limit: 1_073_741_824, // 1 GB
      },
    })
    mockGetContainer.mockReturnValueOnce({ stats: mockStats })

    const service = await createDockerService('/var/run/docker.sock')
    const stats = await service!.getContainerStats('abc123')

    expect(stats).not.toBeNull()
    // CPU: (200M - 100M) / (1000M - 500M) * 4 * 100 = 80%
    expect(stats!.cpuPercent).toBe(80)
    expect(stats!.memoryUsageMb).toBe(128)
    expect(stats!.memoryLimitMb).toBe(1024)
    expect(stats!.memoryPercent).toBeCloseTo(12.5)
  })

  it('returns null when stats fail', async () => {
    const mockStats = vi.fn().mockRejectedValueOnce(new Error('not running'))
    mockGetContainer.mockReturnValueOnce({ stats: mockStats })

    const service = await createDockerService('/var/run/docker.sock')
    const stats = await service!.getContainerStats('abc123')

    expect(stats).toBeNull()
  })
})
