import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { HEARTBEAT_INTERVAL_MS, serializeMessage, parseMessage, type Envelope } from '@firefly0621/dsh-remote-protocol'

/** Outbound relay connection: hello, heartbeat, exponential-backoff reconnect. */
export interface RelayClientOptions {
  relayUrl: string
  deviceId: string
  deviceSecret: string
  /** Invoked when the relay issues a fresh pairing code. */
  onPairing?: (payload: { code: string; expiresAt: number }) => void
  onMessage: (envelope: Envelope) => void
}

export class RelayClient {
  private socket: WebSocket | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private retryDelay = 1_000
  private stopped = false
  /** Device-originated request id → its waiter, resolved by the relay's reply. */
  private readonly pending = new Map<string, (message: Envelope) => void>()
  private readonly MAX_RETRY_MS = 60_000

  constructor(private readonly options: RelayClientOptions) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  /** Open the connection and keep it alive with reconnects until stop(). */
  start(): void {
    this.stopped = false
    this.connect()
  }

  /** Close the connection, stop reconnecting, and drop pending requests. */
  stop(): void {
    this.stopped = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.socket?.terminate()
    this.socket = undefined
    for (const reject of this.pending.values()) reject({ type: 'error', payload: { code: 'client.stopped', message: 'relay client stopped' } })
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
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      this.send({ type, id, payload } as Envelope)
    })
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
        const waiter = this.pending.get(envelope.id)
        if (waiter !== undefined) {
          this.pending.delete(envelope.id)
          waiter(envelope)
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
      this.scheduleReconnect()
    })
    socket.on('error', () => { socket.terminate() })
  }

  private scheduleReconnect(): void {
    const delay = this.retryDelay
    this.retryDelay = Math.min(this.retryDelay * 2, this.MAX_RETRY_MS)
    setTimeout(() => { this.connect() }, delay + Math.random() * 200)
  }
}
