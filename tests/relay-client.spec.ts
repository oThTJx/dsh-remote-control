import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { RelayClient } from '../src/relay-client.ts'
import { RelayServer } from '@firefly0621/dsh-remote-relay'
import { parseMessage, type Envelope } from '@firefly0621/dsh-remote-protocol'

describe('RelayClient', () => {
  let server: WebSocketServer | undefined
  let sockets: WebSocket[] = []
  afterEach(async () => {
    for (const socket of sockets) socket.terminate()
    sockets = []
    if (server !== undefined) {
      const wsServer = server
      await new Promise<void>((resolve) => { wsServer.close(() => { resolve() }) })
      server = undefined
    }
  })

  async function startServer(): Promise<{ url: string; messages: Envelope[] }> {
    const messages: Envelope[] = []
    server = new WebSocketServer({ port: 0 })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    server.on('connection', (socket) => {
      sockets.push(socket)
      socket.on('message', (data) => {
        messages.push(parseMessage(Buffer.from(data as ArrayBuffer).toString()))
      })
    })
    await new Promise<void>((resolve) => {
      server!.on('listening', () => { resolve() })
    })
    return { url: `ws://127.0.0.1:${port}`, messages }
  }

  it('connects and sends hello with the device secret', async () => {
    const { url, messages } = await startServer()
    const client = new RelayClient({
      relayUrl: url,
      deviceId: 'my-pc',
      deviceSecret: 's3cret',
      onMessage: () => {},
    })
    client.start()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(messages.at(-1)).toMatchObject({ type: 'hello', deviceId: 'my-pc', payload: { deviceSecret: 's3cret' } })
    client.stop()
  })

  it('reconnects with backoff after the server drops the socket', async () => {
    const { url, messages } = await startServer()
    const client = new RelayClient({
      relayUrl: url,
      deviceId: 'my-pc',
      deviceSecret: 's3cret',
      onMessage: () => {},
    })
    client.start()
    await new Promise(resolve => setTimeout(resolve, 50))
    for (const socket of sockets) socket.terminate()
    sockets = []
    // First reconnect waits the initial 1s backoff, then 2s, 4s, ...
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect(messages.filter(message => message.type === 'hello').length).toBeGreaterThanOrEqual(2)
    client.stop()
  })

  it('resolves a device-originated request against a real relay reply', async () => {
    const relay = new RelayServer({ port: 0, requireTls: false, deviceSecrets: { 'my-pc': 's' } })
    await relay.start()
    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      deviceId: 'my-pc',
      deviceSecret: 's',
      onMessage: () => {},
    })
    client.start()
    await new Promise(resolve => setTimeout(resolve, 50))
    const reply = await client.request('sessions.list', {})
    expect(reply.type).toBe('sessions.list')
    expect(reply.id).toBeDefined()
    expect(reply.payload).toEqual({ sessions: [] })
    client.stop()
    await relay.close()
  })
})
