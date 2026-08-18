import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createHandler, projectHistory, type HandlerServices } from '../src/handlers.ts'

const entry = {
  id: 'plugin-inventory',
  options: { name: '@deepseek-ai/dsh-host-plugin-inventory', group: undefined },
  disabled: false,
  fiber: { state: 2 },
}

function services(overrides?: Partial<HandlerServices['settings']>): HandlerServices {
  return {
    loader: { entries: () => [entry] },
    settings: {
      describe: () => [],
      mutate: async () => {},
      ...overrides,
    },
  }
}

describe('remote handler', () => {
  it('lists non-group loader entries', async () => {
    const handler = createHandler(services())
    const result = await handler('plugin.list', {}) as { entries: Array<{ entryId: string }> }
    expect(result.entries[0]!.entryId).toBe('plugin-inventory')
  })

  it('describes settings with redaction forced on', async () => {
    let redact: boolean | undefined
    const handler = createHandler(services({
      describe: (options?: { redactSecrets?: boolean }) => { redact = options?.redactSecrets; return [] },
    }))
    await handler('settings.describe', {})
    expect(redact).toBe(true)
  })

  it('mutates a settings namespace through the seam', async () => {
    const calls: unknown[] = []
    const handler = createHandler(services({
      mutate: (ns: string, ops: unknown, revision?: number) => { calls.push([ns, ops, revision]); return Promise.resolve() },
    }))
    await handler('settings.mutate', { ns: 'ui-theme', ops: [{ op: 'set', path: ['theme'], value: 'dark' }], expectedRevision: 3 })
    expect(calls).toEqual([['ui-theme', [{ op: 'set', path: ['theme'], value: 'dark' }], 3]])
  })

  it('rejects an unknown method with a stable error code', async () => {
    const handler = createHandler(services())
    await expect(handler('nope', {})).rejects.toMatchObject({ code: 'method.not-found' })
  })

  it('dispatches chat.send and chat.history through the optional chat service', async () => {
    const sent: Array<{ text: string; sessionId: string | undefined }> = []
    const handler = createHandler({
      ...services(),
      chat: {
        history: async () => ({ messages: [{ role: 'user', text: 'hi' }, { role: 'tool', name: 'bash' }] }),
        stats: async () => ({ stats: { turns: 3, steps: 4, llmMs: 5, toolMs: 6, ttftMs: 7, ttftSteps: 8, decodeMs: 9, decodeTokens: 10 } }),
        send: async (text, sessionId) => { sent.push({ text, sessionId }); return { accepted: true } },
      },
    })
    const result = await handler('chat.send', { text: '你好', sessionId: 's-1' }) as { accepted: boolean }
    expect(result.accepted).toBe(true)
    expect(sent).toEqual([{ text: '你好', sessionId: 's-1' }])
    const history = await handler('chat.history', { sessionId: 's-1' }) as { messages: Array<{ role: string }> }
    expect(history.messages).toEqual([{ role: 'user', text: 'hi' }, { role: 'tool', name: 'bash' }])
    const stats = await handler('chat.stats', { sessionId: 's-1' }) as { stats: { turns: number } }
    expect(stats.stats.turns).toBe(3)
  })

  it('rejects chat.stats without a sessionId', async () => {
    const handler = createHandler({
      ...services(),
      chat: { history: async () => ({ messages: [] }), stats: async () => ({ stats: null }), send: async () => ({ accepted: true }) },
    })
    await expect(handler('chat.stats', {})).rejects.toMatchObject({ code: 'payload.invalid' })
  })

  it('dispatches sessions.list / create / delete through the optional session service', async () => {
    const calls: string[] = []
    const handler = createHandler({
      ...services(),
      sessions: {
        list: async () => ({ sessions: [{ sessionId: 's-1', title: 't', seq: 42 }] }),
        create: async () => { calls.push('create'); return { sessionId: 's-2' } },
        delete: async (sessionId) => { calls.push(`delete:${sessionId}`); return { deleted: true } },
      },
    })
    const list = await handler('sessions.list', {}) as { sessions: Array<{ sessionId: string }> }
    expect(list.sessions).toEqual([{ sessionId: 's-1', title: 't', seq: 42 }])
    const created = await handler('sessions.create', {}) as { sessionId: string }
    expect(created.sessionId).toBe('s-2')
    const deleted = await handler('sessions.delete', { sessionId: 's-2' }) as { deleted: boolean }
    expect(deleted.deleted).toBe(true)
    expect(calls).toEqual(['create', 'delete:s-2'])
  })

  it('rejects chat and session commands with invalid payloads or when unavailable', async () => {
    const bare = createHandler(services())
    await expect(bare('chat.send', { text: 'hi' })).rejects.toMatchObject({ code: 'chat.unavailable' })
    await expect(bare('chat.history', { sessionId: 's' })).rejects.toMatchObject({ code: 'chat.unavailable' })
    await expect(bare('sessions.list', {})).rejects.toMatchObject({ code: 'sessions.unavailable' })
    const withServices = createHandler({
      ...services(),
      sessions: { list: async () => ({ sessions: [] }), create: async () => ({ sessionId: 's' }), delete: async () => ({ deleted: true }) },
      chat: { history: async () => ({ messages: [] }), send: async () => ({ accepted: true }) },
    })
    await expect(withServices('chat.send', { text: '  ' })).rejects.toMatchObject({ code: 'payload.invalid' })
    await expect(withServices('chat.send', { text: 'hi', sessionId: 7 })).rejects.toMatchObject({ code: 'payload.invalid' })
    await expect(withServices('chat.history', {})).rejects.toMatchObject({ code: 'payload.invalid' })
    await expect(withServices('sessions.delete', {})).rejects.toMatchObject({ code: 'payload.invalid' })
  })

  it('dispatches models.list and models.set through the optional model service', async () => {
    const calls: Array<{ sessionId: string; provider: string; model: string }> = []
    const handler = createHandler({
      ...services(),
      models: {
        list: async () => ({ groups: [{ provider: 'deepseek', models: ['a', 'b'] }], current: { provider: 'deepseek', model: 'a' } }),
        set: async (sessionId, provider, model) => { calls.push({ sessionId, provider, model }); return { ok: true } },
      },
    })
    const list = await handler('models.list', {}) as { groups: Array<{ provider: string; models: string[] }> }
    expect(list.groups).toEqual([{ provider: 'deepseek', models: ['a', 'b'] }])
    const set = await handler('models.set', { sessionId: 's', provider: 'deepseek', model: 'b' }) as { ok: boolean }
    expect(set.ok).toBe(true)
    expect(calls).toEqual([{ sessionId: 's', provider: 'deepseek', model: 'b' }])
    await expect(handler('models.set', { sessionId: '', provider: 'p', model: 'm' })).rejects.toMatchObject({ code: 'payload.invalid' })
    await expect(createHandler(services())('models.list', {})).rejects.toMatchObject({ code: 'models.unavailable' })
  })

  it('projects history with tool result summaries', () => {
    const events = [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'tool/call', data: { name: 'bash', callId: 'c1', turn: 1, step: 1, arguments: '{}' } },
      { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'out' }] } } },
      { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'done' }] } } },
    ] as unknown as readonly SessionEvent[]
    expect(projectHistory(events)).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'tool', name: 'bash', result: 'out' },
      { role: 'assistant', text: 'done' },
    ])
  })

  it('marks a failed tool result and truncates long summaries', () => {
    const long = 'x'.repeat(300)
    const events = [
      { type: 'tool/call', data: { name: 'bash', callId: 'c1', turn: 1, step: 1, arguments: '{}' } },
      { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: long }] } } },
      { type: 'tool/call', data: { name: 'read', callId: 'c2', turn: 1, step: 1, arguments: '{}' } },
      { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [] }, error: { code: 'EACCES' } } },
    ] as unknown as readonly SessionEvent[]
    const projected = projectHistory(events)
    expect(projected[0]).toEqual({ role: 'tool', name: 'bash', result: `${'x'.repeat(200)}…` })
    expect(projected[1]).toEqual({ role: 'tool', name: 'read', error: 'EACCES' })
  })
})
