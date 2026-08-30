export interface ProxyOptions {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
  timeout?: number
}

export interface ProxyResponse {
  status: number
  data: unknown
  headers: Record<string, string>
}

export async function proxyRequest(opts: ProxyOptions): Promise<ProxyResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts.headers,
  }

  const controller = new AbortController()
  const timeoutId = opts.timeout
    ? setTimeout(() => controller.abort(), opts.timeout)
    : null

  try {
    const response = await fetch(opts.url, {
      method: opts.method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    })

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    let data: unknown
    const contentType = response.headers.get('content-type')
    if (contentType?.includes('application/json')) {
      data = await response.json()
    } else {
      data = await response.text()
    }

    return { status: response.status, data, headers: responseHeaders }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { status: 504, data: { detail: 'Upstream request timed out' }, headers: {} }
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { status: 502, data: { detail: `Upstream unavailable: ${message}` }, headers: {} }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}
