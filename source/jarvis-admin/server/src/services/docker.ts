import Docker from 'dockerode'

export interface ContainerInfo {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: Array<{ private: number; public: number | null }>
  labels: Record<string, string>
  created: string
}

export interface ContainerStats {
  cpuPercent: number
  memoryUsageMb: number
  memoryLimitMb: number
  memoryPercent: number
}

export interface DockerService {
  isAvailable(): Promise<boolean>
  listJarvisContainers(): Promise<ContainerInfo[]>
  getContainerStatus(id: string): Promise<ContainerInfo | null>
  restartContainer(id: string): Promise<void>
  stopAllJarvisContainers(): Promise<{ stopped: string[]; failed: Array<{ name: string; error: string }> }>
  getContainerStats(id: string): Promise<ContainerStats | null>
  execInContainer(id: string, cmd: string[], env?: string[]): Promise<string>
}

function toContainerInfo(container: Docker.ContainerInfo): ContainerInfo {
  const name = container.Names[0]?.replace(/^\//, '') ?? container.Id.slice(0, 12)
  return {
    id: container.Id,
    name,
    image: container.Image,
    state: container.State,
    status: container.Status,
    ports: (container.Ports ?? []).map((p) => ({
      private: p.PrivatePort,
      public: p.PublicPort ?? null,
    })),
    labels: container.Labels,
    created: new Date(container.Created * 1000).toISOString(),
  }
}

/**
 * Containers we manage that don't follow the jarvis-* naming convention.
 * Add new entries when the registry gains a third-party service whose upstream
 * image hardcodes its container_name (e.g. go2rtc) — otherwise the Dashboard
 * silently omits them.
 */
const NON_PREFIXED_MANAGED_CONTAINERS = new Set(['go2rtc'])

function isJarvisContainer(container: Docker.ContainerInfo): boolean {
  if (container.Labels['com.jarvis.managed'] === 'true') return true
  const name = container.Names[0]?.replace(/^\//, '') ?? ''
  if (name.startsWith('jarvis-') || name.startsWith('jarvis_')) return true
  return NON_PREFIXED_MANAGED_CONTAINERS.has(name)
}

export async function createDockerService(socketPath: string): Promise<DockerService | null> {
  const docker = new Docker({ socketPath })

  const service: DockerService = {
    async isAvailable(): Promise<boolean> {
      try {
        await docker.ping()
        return true
      } catch {
        return false
      }
    },

    async listJarvisContainers(): Promise<ContainerInfo[]> {
      const containers = await docker.listContainers({ all: true })
      return containers.filter(isJarvisContainer).map(toContainerInfo)
    },

    async getContainerStatus(id: string): Promise<ContainerInfo | null> {
      try {
        const container = docker.getContainer(id)
        const info = await container.inspect()
        return {
          id: info.Id,
          name: info.Name.replace(/^\//, ''),
          image: info.Config.Image,
          state: info.State.Status,
          status: info.State.Status,
          ports: Object.entries(info.NetworkSettings.Ports ?? {}).map(([key, bindings]) => ({
            private: parseInt(key.split('/')[0], 10),
            public: bindings?.[0]?.HostPort ? parseInt(bindings[0].HostPort, 10) : null,
          })),
          labels: info.Config.Labels ?? {},
          created: info.Created,
        }
      } catch {
        return null
      }
    },

    async restartContainer(id: string): Promise<void> {
      const container = docker.getContainer(id)
      await container.restart({ t: 10 })
    },

    async stopAllJarvisContainers() {
      const containers = (await docker.listContainers({ all: true })).filter(isJarvisContainer)
      const stopped: string[] = []
      const failed: Array<{ name: string; error: string }> = []

      await Promise.all(
        containers.map(async (info) => {
          const name = info.Names[0]?.replace(/^\//, '') ?? info.Id.slice(0, 12)
          if (info.State !== 'running') return
          try {
            // t: 0 is the deliberate emergency-stop path exposed by the UI.
            await docker.getContainer(info.Id).stop({ t: 0 })
            stopped.push(name)
          } catch (err) {
            failed.push({ name, error: err instanceof Error ? err.message : String(err) })
          }
        }),
      )

      return { stopped: stopped.sort(), failed }
    },

    async execInContainer(id: string, cmd: string[], env: string[] = []): Promise<string> {
      const container = docker.getContainer(id)
      const exec = await container.exec({
        Cmd: cmd,
        Env: env,
        AttachStdout: true,
        AttachStderr: true,
      })

      const stream = await exec.start({ hijack: true, stdin: false })

      // Demux the Docker multiplexed stream into separate stdout/stderr buffers.
      // Raw hijacked streams prefix each frame with an 8-byte header:
      //   [stream_type(1), 0, 0, 0, size(4)] + payload
      // Without demuxing, these binary headers corrupt the output.
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      const { PassThrough } = await import('node:stream')
      const stdout = new PassThrough()
      const stderr = new PassThrough()

      stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
      stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

      docker.modem.demuxStream(stream, stdout, stderr)

      return new Promise((resolve, reject) => {
        stream.on('end', () => {
          stdout.end()
          stderr.end()
          const out = Buffer.concat(stdoutChunks).toString('utf-8')
          const err = Buffer.concat(stderrChunks).toString('utf-8')
          // Resolve with stdout; include stderr only if stdout is empty
          resolve(out || err)
        })
        stream.on('error', reject)

        // Timeout after 10 minutes (large model downloads)
        setTimeout(() => {
          stream.destroy()
          reject(new Error('Exec timed out after 10 minutes'))
        }, 600_000)
      })
    },

    async getContainerStats(id: string): Promise<ContainerStats | null> {
      try {
        const container = docker.getContainer(id)
        const stats = (await container.stats({ stream: false })) as {
          cpu_stats: {
            cpu_usage: { total_usage: number }
            system_cpu_usage: number
            online_cpus: number
          }
          precpu_stats: {
            cpu_usage: { total_usage: number }
            system_cpu_usage: number
          }
          memory_stats: { usage: number; limit: number }
        }

        const cpuDelta =
          stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage
        const systemDelta =
          stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage
        const cpuPercent =
          systemDelta > 0
            ? (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100
            : 0

        const memoryUsageMb = stats.memory_stats.usage / (1024 * 1024)
        const memoryLimitMb = stats.memory_stats.limit / (1024 * 1024)
        const memoryPercent = memoryLimitMb > 0 ? (memoryUsageMb / memoryLimitMb) * 100 : 0

        return { cpuPercent, memoryUsageMb, memoryLimitMb, memoryPercent }
      } catch {
        return null
      }
    },
  }

  if (await service.isAvailable()) {
    return service
  }
  return null
}
