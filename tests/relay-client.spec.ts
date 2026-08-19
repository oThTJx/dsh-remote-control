import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { RelayClient, isPlaintextRelayAllowed } from '../src/relay-client.ts'
import { RelayServer } from '@firefly0621/dsh-remote-relay'
import { parseMessage, type Envelope } from '@firefly0621/dsh-remote-protocol'

describe('isPlaintextRelayAllowed', () => {
  it.each([
    // wss is always fine.
    ['wss://relay.example.com', true],
    // Loopback plaintext: the local relay.
    ['ws://127.0.0.1:8787', true],
    ['ws://localhost:8787', true],
    ['ws://[::1]:8787', true],
    ['ws://[::]:8787', true],
    // Private/LAN plaintext: a relay on the home network.
    ['ws://10.0.0.5:8787', true],
    ['ws://172.16.1.1:8787', true],
    ['ws://192.168.1.5:8787', true],
    ['ws://169.254.1.1:8787', true],
    // Everything else must encrypt.
    ['ws://relay.example.com', false],
    ['ws://8.8.8.8:8787', false],
    ['ws://[2001:db8::1]:8787', false],
    ['ws://[::ffff:127.0.0.1]:8787', false],
    // Private-range edge misses: each range check's false arm.
    ['ws://172.32.1.1:8787', false],
    ['ws://192.169.1.1:8787', false],
    ['ws://169.253.1.1:8787', false],
    ['not-a-url', false],
    ['http://relay.example.com', false],
  ])('%s → %s', (url, allowed) => {
    expect(isPlaintextRelayAllowed(url)).toBe(allowed)
  })
})

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

  it('refuses a plaintext relay URL that is not loopback or private', () => {
    expect(() => new RelayClient({
      relayUrl: 'ws://relay.example.com',
      deviceId: 'my-pc',
      deviceSecret: 's',
      onMessage: () => {},
    })).toThrow(/wss/)
  })

  it('rejects a request sent while disconnected', async () => {
    const client = new RelayClient({
      relayUrl: 'ws://127.0.0.1:1',
      deviceId: 'my-pc',
      deviceSecret: 's',
      onMessage: () => {},
    })
    await expect(client.request('sessions.list', {})).rejects.toThrow('relay not connected')
    client.stop()
  })

  it('times out a request the relay never answers', async () => {
    const { url } = await startServer()
    const client = new RelayClient({
      relayUrl: url,
      deviceId: 'my-pc',
      deviceSecret: 's',
      onMessage: () => {},
    })
    client.start()
    await new Promise(resolve => setTimeout(resolve, 50))
    await expect(client.request('sessions.list', {}, 200)).rejects.toThrow('timed out')
    client.stop()
  })

  it('fails in-flight requests when stopped', async () => {
    const { url } = await startServer()
    const client = new RelayClient({
      relayUrl: url,
      deviceId: 'my-pc',
      deviceSecret: 's',
      onMessage: () => {},
    })
    client.start()
    await new Promise(resolve => setTimeout(resolve, 50))
    const pending = client.request('sessions.list', {})
    client.stop()
    await expect(pending).rejects.toThrow('relay client stopped')
  })

  it('fails in-flight requests when the connection drops', async () => {
    const { url } = await startServer()
    const client = new RelayClient({
      relayUrl: url,
      deviceId: 'my-pc',
      deviceSecret: 's',
      onMessage: () => {},
    })
    client.start()
    await new Promise(resolve => setTimeout(resolve, 50))
    const pending = client.request('sessions.list', {})
    // The server dies without replying; the pending request must fail instead
    // of hanging until its timeout.
    for (const socket of sockets) socket.terminate()
    sockets = []
    await expect(pending).rejects.toThrow('relay connection lost')
    client.stop()
  })

  it('stops reconnecting when the relay reports device.replaced', async () => {
    const relay = new RelayServer({ port: 0, requireTls: false, deviceSecrets: { 'my-pc': 's' } })
    await relay.start()
    const url = `ws://127.0.0.1:${relay.port}`
    const failures: string[] = []
    const first = new RelayClient({
      relayUrl: url,
      deviceId: 'my-pc',
      deviceSecret: 's',
      onFailure: (error) => { failures.push(error.message) },
      onMessage: () => {},
    })
    first.start()
    await new Promise(resolve => setTimeout(resolve, 50))

    const second = new RelayClient({
      relayUrl: url,
      deviceId: 'my-pc',
      deviceSecret: 's',
      onMessage: () => {},
    })
    second.start()
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(failures.some(message => message.includes('registered elsewhere'))).toBe(true)
    first.stop()
    second.stop()
    await relay.close()
  })

  it('reports an unreachable relay through onFailure', async () => {
    const failures: string[] = []
    const client = new RelayClient({
      relayUrl: 'ws://127.0.0.1:1',
      deviceId: 'my-pc',
      deviceSecret: 's',
      onFailure: (error) => { failures.push(error.message) },
      onMessage: () => {},
    })
    client.start()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(failures.length).toBeGreaterThan(0)
    client.stop()
  })
})
