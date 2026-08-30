import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  exec: mockExec,
}))

vi.mock('node:util', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:util')>()
  return {
    ...original,
    promisify: (fn: unknown) => {
      if (fn === mockExec) {
        return (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            mockExec(...args, (err: Error | null, result: unknown) => {
              if (err) reject(err)
              else resolve(result)
            })
          })
      }
      return original.promisify(fn as (...args: unknown[]) => unknown)
    },
  }
})

import { createComposeService } from '../../src/services/compose.js'

describe('ComposeService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs docker compose up for enableModule', async () => {
    mockExec.mockImplementationOnce(
      (_cmd: string, _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: 'done', stderr: '' })
      },
    )

    const compose = createComposeService()
    const result = await compose.enableModule('recipes')

    expect(result.stdout).toBe('done')
    expect(mockExec).toHaveBeenCalledWith(
      'docker compose  --profile recipes up -d',
      expect.objectContaining({ timeout: 120_000 }),
      expect.any(Function),
    )
  })

  it('runs docker compose stop for disableModule', async () => {
    mockExec.mockImplementationOnce(
      (_cmd: string, _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: 'stopped', stderr: '' })
      },
    )

    const compose = createComposeService()
    const result = await compose.disableModule('recipes')

    expect(result.stdout).toBe('stopped')
    expect(mockExec).toHaveBeenCalledWith(
      'docker compose  --profile recipes stop',
      expect.objectContaining({ timeout: 60_000 }),
      expect.any(Function),
    )
  })

  it('includes -f flag when composePath is provided', async () => {
    mockExec.mockImplementationOnce(
      (_cmd: string, _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: '', stderr: '' })
      },
    )

    const compose = createComposeService()
    await compose.enableModule('ocr', '/path/to/docker-compose.yml')

    expect(mockExec).toHaveBeenCalledWith(
      'docker compose -f /path/to/docker-compose.yml --profile ocr up -d',
      expect.anything(),
      expect.any(Function),
    )
  })

  it('rejects when exec fails', async () => {
    mockExec.mockImplementationOnce(
      (_cmd: string, _opts: unknown, cb: (err: Error) => void) => {
        cb(new Error('command failed'))
      },
    )

    const compose = createComposeService()
    await expect(compose.enableModule('bad')).rejects.toThrow('command failed')
  })
})
