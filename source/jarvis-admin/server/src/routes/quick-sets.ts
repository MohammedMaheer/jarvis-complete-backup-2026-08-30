import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { requireSuperuser } from '../middleware/auth.js'
import { proxyRequest } from '../services/proxy.js'

interface Preset {
  id: string
  name: string
  family: string
  description: string
  chatFormat: string
  promptProvider: string
  defaultBackend: string
  defaultContextWindow: number
  isCustom?: boolean
}

interface PresetsFile {
  presets: Preset[]
}

interface ApplyBody {
  presetId: string
  modelName: string
  contextWindow?: number
  backend?: string
  chatFormat?: string
  promptProvider?: string
  targets?: ('live' | 'background')[]
}

interface CreateCustomBody {
  name: string
  family: string
  description?: string
  chatFormat: string
  promptProvider: string
  defaultBackend?: string
  defaultContextWindow?: number
}

interface AppliedSetting {
  key: string
  service: string
  success: boolean
  error?: string
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const CUSTOM_PRESETS_PATH = join(homedir(), '.jarvis', 'custom-quick-sets.json')

function loadBuiltinPresets(): Preset[] {
  const filePath = join(__dirname, '..', 'data', 'quick-sets.json')
  const data = JSON.parse(readFileSync(filePath, 'utf-8')) as PresetsFile
  return data.presets
}

function loadCustomPresets(): Preset[] {
  if (!existsSync(CUSTOM_PRESETS_PATH)) return []
  try {
    const data = JSON.parse(readFileSync(CUSTOM_PRESETS_PATH, 'utf-8')) as PresetsFile
    return data.presets.map((p) => ({ ...p, isCustom: true }))
  } catch {
    return []
  }
}

function saveCustomPresets(presets: Preset[]): void {
  writeFileSync(CUSTOM_PRESETS_PATH, JSON.stringify({ presets }, null, 2) + '\n')
}

function loadAllPresets(): Preset[] {
  return [...loadBuiltinPresets(), ...loadCustomPresets()]
}

export async function quickSetsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSuperuser)

  /**
   * List available model presets (built-in + custom) and current model configuration.
   */
  app.get('/', async (request, reply) => {
    const presets = loadAllPresets()

    // Fetch actual loaded model from health endpoint (no auth needed, always accurate)
    // and context window from settings (needs auth)
    const llmUrl = app.config.llmProxyUrl
    let modelName = ''
    let contextWindow = 0

    if (llmUrl) {
      const [healthResult, ctxResult] = await Promise.all([
        proxyRequest({
          method: 'GET',
          url: `${llmUrl}/health`,
          timeout: 5_000,
        }).catch(() => null),
        proxyRequest({
          method: 'GET',
          url: `${llmUrl}/settings/model.main.context_window`,
          headers: { Authorization: request.headers.authorization! },
          timeout: 5_000,
        }).catch(() => null),
      ])

      if (healthResult?.status === 200) {
        const health = healthResult.data as Record<string, unknown>
        const modelService = health.model_service as Record<string, unknown> | undefined
        const aliases = modelService?.aliases as Record<string, string> | undefined
        // Use the live model alias (most relevant), fall back to first loaded model
        modelName = aliases?.live
          ?? (Array.isArray(modelService?.models) ? (modelService.models as string[])[0] : '')
          ?? ''
      }
      if (ctxResult?.status === 200) {
        const data = ctxResult.data as { value?: number }
        contextWindow = typeof data.value === 'number' ? data.value : parseInt(String(data.value ?? '0'), 10)
      }
    }

    return reply.send({
      presets,
      currentValues: { modelName, contextWindow },
    })
  })

  /**
   * Apply a model preset: bulk-write settings to llm-proxy and command-center,
   * then restart the llm-proxy container.
   *
   * Supports overriding chatFormat and promptProvider from the preset defaults,
   * and targeting specific model tiers (live, background, or both).
   */
  app.post<{ Body: ApplyBody }>('/apply', async (request, reply) => {
    const {
      presetId,
      modelName,
      contextWindow,
      backend,
      chatFormat: chatFormatOverride,
      promptProvider: promptProviderOverride,
      targets,
    } = request.body as ApplyBody

    if (!presetId) {
      return reply.code(400).send({ error: 'presetId is required' })
    }
    if (!modelName || !modelName.trim()) {
      return reply.code(400).send({ error: 'modelName is required' })
    }

    const allPresets = loadAllPresets()
    const preset = allPresets.find((p) => p.id === presetId)
    if (!preset) {
      return reply.code(404).send({ error: `Preset "${presetId}" not found` })
    }

    const llmUrl = app.config.llmProxyUrl
    if (!llmUrl) {
      return reply.code(503).send({ error: 'LLM proxy URL not configured' })
    }

    const applied: AppliedSetting[] = []
    const resolvedChatFormat = chatFormatOverride ?? preset.chatFormat
    const resolvedPromptProvider = promptProviderOverride ?? preset.promptProvider
    const resolvedBackend = backend ?? preset.defaultBackend

    // Determine which model tiers to write to
    const tiers = targets && targets.length > 0 ? targets : ['live' as const]

    // Build llm-proxy settings payload for each target tier
    const llmSettings: Record<string, unknown> = {}
    for (const tier of tiers) {
      const prefix = tier === 'live' ? 'model.live' : 'model.background'
      llmSettings[`${prefix}.name`] = modelName.trim()
      llmSettings[`${prefix}.chat_format`] = resolvedChatFormat
      llmSettings[`${prefix}.backend`] = resolvedBackend
      if (contextWindow && contextWindow > 0) {
        llmSettings[`${prefix}.context_window`] = contextWindow
      }
    }

    // Write llm-proxy settings
    const settingsResult = await proxyRequest({
      method: 'PUT',
      url: `${llmUrl}/settings/`,
      headers: { Authorization: request.headers.authorization! },
      body: { settings: llmSettings },
      timeout: 10_000,
    })

    if (settingsResult.status === 200) {
      for (const key of Object.keys(llmSettings)) {
        applied.push({ key, service: 'jarvis-llm-proxy-api', success: true })
      }
    } else {
      for (const key of Object.keys(llmSettings)) {
        applied.push({
          key,
          service: 'jarvis-llm-proxy-api',
          success: false,
          error: `HTTP ${settingsResult.status}`,
        })
      }
      return reply.code(502).send({
        success: false,
        applied,
        message: 'Failed to write LLM proxy settings',
      })
    }

    // Write prompt provider to command-center via settings-server
    if (app.config.configServiceUrl) {
      try {
        const ppResult = await proxyRequest({
          method: 'PUT',
          url: `${app.config.configServiceUrl}/v1/settings/jarvis-command-center/llm.interface`,
          headers: { Authorization: request.headers.authorization! },
          body: { value: resolvedPromptProvider },
          timeout: 10_000,
        })
        applied.push({
          key: 'llm.interface',
          service: 'jarvis-command-center',
          success: ppResult.status === 200,
          error: ppResult.status !== 200 ? `HTTP ${ppResult.status}` : undefined,
        })
      } catch (err) {
        applied.push({
          key: 'llm.interface',
          service: 'jarvis-command-center',
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    // Restart llm-proxy containers
    const docker = app.docker
    if (docker) {
      try {
        const containers = await docker.listJarvisContainers()
        const llmContainers = containers.filter(
          (c) => c.name.includes('llm-proxy') || c.name.includes('llm_proxy')
        )
        for (const container of llmContainers) {
          await docker.restartContainer(container.id)
        }
      } catch (err) {
        console.warn('[quick-sets] Container restart failed:', err)
      }
    }

    const allSuccess = applied.every((a) => a.success)
    return reply.send({
      success: allSuccess,
      applied,
      message: allSuccess
        ? `Applied "${preset.name}" preset. LLM proxy restarting.`
        : `Applied "${preset.name}" with some errors. Check details.`,
    })
  })

  /**
   * Create a custom preset.
   */
  app.post<{ Body: CreateCustomBody }>('/custom', async (request, reply) => {
    const { name, family, description, chatFormat, promptProvider, defaultBackend, defaultContextWindow } =
      request.body as CreateCustomBody

    if (!name?.trim()) {
      return reply.code(400).send({ error: 'name is required' })
    }
    if (!chatFormat?.trim()) {
      return reply.code(400).send({ error: 'chatFormat is required' })
    }
    if (!promptProvider?.trim()) {
      return reply.code(400).send({ error: 'promptProvider is required' })
    }

    const custom = loadCustomPresets()
    const preset: Preset = {
      id: `custom-${randomUUID().slice(0, 8)}`,
      name: name.trim(),
      family: family?.trim() || 'Custom',
      description: description?.trim() || '',
      chatFormat: chatFormat.trim(),
      promptProvider: promptProvider.trim(),
      defaultBackend: defaultBackend?.trim() || 'GGUF',
      defaultContextWindow: defaultContextWindow ?? 8192,
      isCustom: true,
    }

    custom.push(preset)
    saveCustomPresets(custom)

    return reply.code(201).send({ preset })
  })

  /**
   * Delete a custom preset.
   */
  app.delete<{ Params: { id: string } }>('/custom/:id', async (request, reply) => {
    const { id } = request.params

    const custom = loadCustomPresets()
    const idx = custom.findIndex((p) => p.id === id)
    if (idx === -1) {
      return reply.code(404).send({ error: `Custom preset "${id}" not found` })
    }

    custom.splice(idx, 1)
    saveCustomPresets(custom)

    return reply.send({ success: true })
  })
}
