import type { FastifyInstance } from 'fastify'
import { readFile } from 'node:fs/promises'
import { VERSION } from '../version.js'

type StartupStatus = 'starting' | 'ready' | 'failed' | 'degraded' | 'unknown'

interface StartupReport {
  status?: StartupStatus
  stage?: string
  message?: string
  timestamp?: string
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: VERSION,
    }
  })

  app.get('/startup', async () => {
    const reportPath = process.env.JARVIS_STARTUP_REPORT
    if (!reportPath) {
      return { status: 'unknown', stage: 'dashboard', message: 'No launcher report is available.' }
    }

    try {
      const raw = await readFile(reportPath, 'utf8')
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as StartupReport
      return {
        status: parsed.status ?? 'unknown',
        stage: parsed.stage ?? 'unknown',
        message: parsed.message ?? 'Launcher did not include a status message.',
        timestamp: parsed.timestamp ?? null,
      }
    } catch {
      return { status: 'unknown', stage: 'dashboard', message: 'Launcher report could not be read.' }
    }
  })
}
