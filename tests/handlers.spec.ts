import { describe, expect, it } from 'vitest'
import { createHandler, type HandlerServices } from '../src/handlers.ts'

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

  it('dispatches chat.send through the optional chat service', async () => {
    const sent: Array<{ text: string; sessionId: string | undefined }> = []
    const handler = createHandler({
      ...services(),
      chat: {
        sessions: async () => ({ sessions: [] }),
        send: async (text, sessionId) => { sent.push({ text, sessionId }); return { accepted: true } },
      },
    })
    const result = await handler('chat.send', { text: '你好', sessionId: 's-1' }) as { accepted: boolean }
    expect(result.accepted).toBe(true)
    expect(sent).toEqual([{ text: '你好', sessionId: 's-1' }])
  })

  it('lists chat sessions through the optional chat service', async () => {
    const handler = createHandler({
      ...services(),
      chat: {
        sessions: async () => ({ sessions: [{ sessionId: 's-1', seq: 42 }] }),
        send: async () => ({ accepted: true }),
      },
    })
    const result = await handler('chat.sessions', {}) as { sessions: Array<{ sessionId: string; seq: number }> }
    expect(result.sessions).toEqual([{ sessionId: 's-1', seq: 42 }])
  })

  it('rejects chat.send without text or when chat is unavailable', async () => {
    const withoutChat = createHandler(services())
    await expect(withoutChat('chat.send', { text: 'hi' })).rejects.toMatchObject({ code: 'chat.unavailable' })
    await expect(withoutChat('chat.sessions', {})).rejects.toMatchObject({ code: 'chat.unavailable' })
    const withChat = createHandler({
      ...services(),
      chat: { sessions: async () => ({ sessions: [] }), send: async () => ({ accepted: true }) },
    })
    await expect(withChat('chat.send', { text: '  ' })).rejects.toMatchObject({ code: 'payload.invalid' })
    await expect(withChat('chat.send', { text: 'hi', sessionId: 7 })).rejects.toMatchObject({ code: 'payload.invalid' })
  })
})
