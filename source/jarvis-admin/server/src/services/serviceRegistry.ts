import { resolveServiceUrls, type ServiceMap } from './configService.js'

const DEFAULT_TTL_MS = 5 * 60 * 1000

/**
 * Resolves service URLs from jarvis-config-service on demand, with a short
 * TTL cache and in-flight deduplication. Routes that proxy to a discovered
 * service (e.g. command-center) should call `get(name)` per request instead
 * of caching a URL at boot — that way a transient config-service hiccup at
 * startup can't leave the URL empty for the container's lifetime.
 */
export interface ServiceRegistryOptions {
  ttlMs?: number
  /**
   * URL style to request from config-service. "dockerized" makes
   * config-service rewrite localhost → host.docker.internal, needed when
   * admin runs in Docker on macOS and the target service runs on the host.
   * Typically sourced from `JARVIS_CONFIG_URL_STYLE`.
   */
  style?: string
}

export class ServiceRegistry {
  private cache: ServiceMap | null = null
  private fetchedAt = 0
  private inflight: Promise<ServiceMap> | null = null
  private readonly ttlMs: number
  private readonly style: string | undefined

  constructor(
    private readonly configServiceUrl: string,
    options: ServiceRegistryOptions | number = {},
  ) {
    // Backwards-compatible signature: prior callers passed `ttlMs` as the
    // second positional argument.
    if (typeof options === 'number') {
      this.ttlMs = options
      this.style = undefined
    } else {
      this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
      this.style = options.style
    }
  }

  async get(serviceName: string): Promise<string> {
    const urls = await this.getAll()
    const url = urls.get(serviceName)
    if (!url) {
      throw new Error(
        `Service '${serviceName}' is not registered with config-service at ${this.configServiceUrl}`,
      )
    }
    return url
  }

  /** Drop the cache so the next get() refetches. Intended for tests + admin tooling. */
  invalidate(): void {
    this.cache = null
    this.fetchedAt = 0
  }

  private async getAll(): Promise<ServiceMap> {
    if (this.cache && Date.now() - this.fetchedAt < this.ttlMs) {
      return this.cache
    }
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      try {
        const urls = await resolveServiceUrls(this.configServiceUrl, this.style)
        this.cache = urls
        this.fetchedAt = Date.now()
        return urls
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }
}
