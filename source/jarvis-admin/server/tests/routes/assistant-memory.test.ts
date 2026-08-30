import { afterEach, describe, expect, it, vi } from 'vitest'

import { classifyExplicitMemory, isSafeMemoryContent, saveExplicitMemory, shouldRetrieveMemory } from '../../src/routes/assistant.js'

afterEach(() => {
  delete process.env.JARVIS_PRIMARY_HOUSEHOLD_ID
})

describe('explicit memory safety gate', () => {
  it('allows ordinary operator preferences', () => {
    expect(isSafeMemoryContent('Prefer concise engineering summaries.')).toBe(true)
  })

  it('rejects credentials and private key material', () => {
    expect(isSafeMemoryContent('my password is hunter2')).toBe(false)
    expect(isSafeMemoryContent('API key: sk-12345678901234567890')).toBe(false)
    expect(isSafeMemoryContent('-----BEGIN PRIVATE KEY-----')).toBe(false)
  })
})

describe('memory routing', () => {
  it('skips trivial commands and recalls context for explicit continuity requests', () => {
    expect(shouldRetrieveMemory('What time is it?')).toBe(false)
    expect(shouldRetrieveMemory('Open calculator')).toBe(false)
    expect(shouldRetrieveMemory('Use the same format as last time')).toBe(true)
    expect(shouldRetrieveMemory('Continue my previous project plan')).toBe(true)
    expect(shouldRetrieveMemory('Open my work browser')).toBe(true)
  })
})

describe('explicit memory classification', () => {
  it('keys replaceable editor and browser preferences', () => {
    expect(classifyExplicitMemory('Always use VS Code for Python.')).toMatchObject({ category: 'preference', key: 'preference.editor.python', isPinned: true })
    expect(classifyExplicitMemory('I use Edge for work.')).toMatchObject({ category: 'preference', key: 'preference.browser.work', isPinned: true })
  })

  it('keeps aliases, procedures, projects, and episodes distinct', () => {
    expect(classifyExplicitMemory('When I say coworker, I mean the Efforts AI Coworker project.').category).toBe('alias')
    expect(classifyExplicitMemory('Save this as a routine called Work Mode.').category).toBe('procedure')
    expect(classifyExplicitMemory('Remember this issue for this project.').category).toBe('project')
    expect(classifyExplicitMemory('We fixed this last time by correcting the import case.').category).toBe('episode')
  })
})

describe('persistent memory verification', () => {
  it('reports success only after an exact scoped read-back', async () => {
    process.env.JARVIS_PRIMARY_HOUSEHOLD_ID = 'household-1'
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: 7,
        content: 'Always use VS Code for Python',
        category: 'preference',
        source: 'explicit_user',
        is_pinned: true,
        key: 'preference.editor.python',
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(saveExplicitMemory('Bearer local-token', 1, 'Always use VS Code for Python.', fetcher as typeof fetch)).resolves.toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not claim persistence when the accepted write cannot be read back', async () => {
    process.env.JARVIS_PRIMARY_HOUSEHOLD_ID = 'household-1'
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 201 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(saveExplicitMemory('Bearer local-token', 1, 'Remember this project decision.', fetcher as typeof fetch)).resolves.toBe(false)
  })
})
