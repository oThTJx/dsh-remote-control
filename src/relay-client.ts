import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import WebSocket from 'ws'
import { HEARTBEAT_INTERVAL_MS, serializeMessage, parseMessage, type Envelope } from '@firefly0621/dsh-remote-protocol'

/** Outbound relay connection: hello, heartbeat, exponential-backoff reconnect. */
export interface RelayClientOptions {
  relayUrl: string
  deviceId: string
  deviceSecret: string
  /** Invoked when the relay issues a fresh pairing code. */
  onPairing?: (payload: { code: string; expiresAt: number }) => void
  /** Invoked when a connect attempt fails before the socket opens. */
  onFailure?: (error: Error) => void
  /** Invoked when an established connection drops (reconnects keep running). */
  onDisconnect?: () => void
  onMessage: (envelope: Envelope) => void
}

/** One device-originated request awaiting its correlated reply. */
interface PendingRequest {
  timer: NodeJS.Timeout
  resolve: (message: Envelope) => void
  reject: (error: Error) => void
}

/**
 * Plaintext `ws://` is acceptable only toward a loopback or private-network
 * relay (the local relay, a LAN host); every other target must be `wss://` so
 * the long-lived device secret never transits in the clear.
 */
export function isPlaintextRelayAllowed(relayUrl: string): boolean {
  let url: URL
  try {
    url = new URL(relayUrl)
  } catch {
    return false
  }
  if (url.protocol === 'wss:') return true
  if (url.protocol !== 'ws:') return false
  // URL.hostname keeps the brackets on IPv6 literals.
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host === '::') return true
  if (isIP(host) === 6) return false
  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  return false
}

export class RelayClient {
  private socket: WebSocket | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private retryDelay = 1_000
  private stopped = false
  private readonly pending = new Map<string, PendingRequest>()
  private readonly MAX_RETRY_MS = 60_000

  constructor(private readonly options: RelayClientOptions) {
    if (!isPlaintextRelayAllowed(options.relayUrl)) {
      throw new Error(`relay URL must use wss:// unless it is a loopback or private-network address: ${options.relayUrl}`)
    }
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  /** Open the connection and keep it alive with reconnects until stop(). */
  start(): void {
    this.stopped = false
    this.retryDelay = 1_000
    this.connect()
  }

  /** Close the connection, stop reconnecting, and drop pending requests. */
  stop(): void {
    this.stopped = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.socket?.terminate()
    this.socket = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('relay client stopped'))
    }
    this.pending.clear()
  }

  /** Send one envelope over the live connection, dropping it when offline. */
  send(envelope: Envelope): void {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return
    socket.send(serializeMessage(envelope))
  }

  /**
   * Send one device-originated relay command and await its correlated reply.
   * @param type - the command type; the relay echoes the same type with an id.
   * @param payload - command payload.
   * @param timeoutMs - reply budget; rejects with a timeout error when exceeded.
   * @returns the relay's reply envelope (error replies included).
   */
  request(type: 'sessions.list' | 'sessions.revoke', payload: object, timeoutMs = 5_000): Promise<Envelope> {
    const id = randomUUID()
    return new Promise<Envelope>((resolve, reject) => {
      if (!this.connected) {
        reject(new Error(`relay not connected; cannot send ${type}`))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`relay request ${type} timed out`))
      }, timeoutMs)
      this.pending.set(id, { timer, resolve, reject })
      this.send({ type, id, payload })
    })
  }

  /** Fail every in-flight request (their replies can no longer arrive). */
  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private connect(): void {
    if (this.stopped) return
    const socket = new WebSocket(this.options.relayUrl)
    this.socket = socket
    socket.on('open', () => {
      this.retryDelay = 1_000
      socket.send(serializeMessage({
        type: 'hello',
        deviceId: this.options.deviceId,
        payload: { deviceSecret: this.options.deviceSecret },
      }))
      this.heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(serializeMessage({ type: 'ping', payload: {} }))
        }
      }, HEARTBEAT_INTERVAL_MS)
    })
    socket.on('message', (data) => {
      let envelope: Envelope
      try {
        envelope = parseMessage(Buffer.from(data as ArrayBuffer).toString())
      } catch (error) {
        this.options.onMessage({ type: 'error', payload: { code: 'protocol.invalid', message: (error as Error).message } })
        return
      }
      if (envelope.id !== undefined) {
        const pending = this.pending.get(envelope.id)
        if (pending !== undefined) {
          this.pending.delete(envelope.id)
          clearTimeout(pending.timer)
          pending.resolve(envelope)
          return
        }
      }
      if (envelope.type === 'error') {
        const code = (envelope.payload as { code?: unknown }).code
        if (code === 'device.replaced') {
          // Another host registered the same deviceId; reconnecting would kick
          // the winner in a loop — stop until the operator fixes the conflict.
          this.stopped = true
          if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
          this.heartbeat = undefined
          this.failPending(new Error('device replaced elsewhere'))
          this.options.onFailure?.(new Error('this deviceId was registered elsewhere; check for duplicate configuration'))
          socket.terminate()
          return
        }
      }
      if (envelope.type === 'pairing.issue') {
        this.options.onPairing?.(envelope.payload as { code: string; expiresAt: number })
      }
      this.options.onMessage(envelope)
    })
    socket.on('close', () => {
      if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
      this.heartbeat = undefined
      if (this.stopped || this.socket !== socket) return
      this.failPending(new Error('relay connection lost'))
      this.options.onDisconnect?.()
      this.scheduleReconnect()
    })
    socket.on('error', () => {
      if (socket.readyState !== WebSocket.OPEN) {
        this.options.onFailure?.(new Error(`cannot reach relay at ${this.options.relayUrl}`))
      }
      socket.terminate()
    })
  }

  private scheduleReconnect(): void {
    const delay = this.retryDelay
    this.retryDelay = Math.min(this.retryDelay * 2, this.MAX_RETRY_MS)
    setTimeout(() => { this.connect() }, delay + Math.random() * 200)
  }
}
