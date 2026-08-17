import { networkInterfaces } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
// Loader's Context declaration merge provides ctx.loader.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { RelayServer } from '@firefly0621/dsh-remote-relay'
import type { SessionInfo } from '@firefly0621/dsh-remote-protocol'
import { RelayClient } from './relay-client.ts'
import { createHandler, HandlerError } from './handlers.ts'
import { resolveIdentity, generateIdentity, type Identity } from './identity.ts'
import { RemoteControlGateway } from './gateway.ts'
import type { PairingSnapshot } from './pairing-state.ts'

/** Plugin config; everything is optional — the default boots a local relay with an auto-generated identity. */
export interface Config {
  /** Public relay WSS URL, e.g. wss://relay.example.com; absent starts an embedded local relay on `port`. */
  relayUrl?: string
  /**
   * The address phones use to reach the relay, shown in the pairing QR and
   * panel. Defaults to `relayUrl`, or the auto-detected LAN IP when the
   * embedded relay is used. Self-hosters behind a domain or port-forward set
   * this explicitly when the phone-facing address differs from the outbound one.
   */
  phoneRelayUrl?: string
  /** Stable device id; auto-generated and persisted when absent. */
  deviceId?: string
  /** Long-lived secret registered on the relay for this deviceId; auto-generated and persisted when absent. */
  deviceSecret?: string
  /** Port for the embedded local relay; defaults to 8787. */
  port?: number
}

export const name = 'remote-control'

export const inject = ['settings', 'loader']

export const Config: z<Config> = z.object({
  relayUrl: z.string(),
  phoneRelayUrl: z.string(),
  deviceId: z.string(),
  deviceSecret: z.string().role('secret'),
  port: z.number(),
})

/** First non-internal IPv4 address, for the phone-facing QR URL of a local relay. */
export function lanIPv4(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return '127.0.0.1'
}

/** Serve remote commands over the outbound relay connection. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const { identity, scope } = resolveIdentity(ctx, config)
  let current: Identity = identity

  const state: PairingSnapshot = { status: 'connecting' }

  // Zero-config default: embed a local relay on this host so a fresh install
  // pairs against ws://127.0.0.1:8787 with no deployment steps at all.
  let relay: RelayServer | undefined
  let relayUrl = config.relayUrl
  let phoneRelayUrl: string
  if (relayUrl === undefined) {
    const port = config.port ?? 8787
    // The embedded relay accepts the auto-generated identity's first hello and
    // lets a reset identity register after a fresh generation.
    relay = new RelayServer({
      port,
      requireTls: false,
      deviceSecrets: { [current.deviceId]: current.deviceSecret },
      allowAutoRegister: true,
    })
    await relay.start()
    relayUrl = `ws://127.0.0.1:${relay.port}`
    phoneRelayUrl = `ws://${lanIPv4()}:${relay.port}`
  } else {
    phoneRelayUrl = relayUrl
  }
  // Explicit phone-facing override wins; self-hosters behind a domain or
  // port-forward point the QR at their public address this way.
  if (config.phoneRelayUrl !== undefined) phoneRelayUrl = config.phoneRelayUrl

  const handler = createHandler({
    loader: ctx.loader,
    settings: ctx.settings,
  })

  let client: RelayClient | undefined
  const startClient = (): void => {
    client?.stop()
    client = new RelayClient({
      relayUrl,
      deviceId: current.deviceId,
      deviceSecret: current.deviceSecret,
      onPairing: (payload) => {
        state.status = 'pairing'
        state.code = payload.code
        state.expiresAt = payload.expiresAt
        state.phoneRelayUrl = phoneRelayUrl
      },
      onMessage: (message) => {
        if (message.type === 'request') {
          const { method, params } = message.payload as { method: string; params: unknown }
          const id = message.id
          void handler(method, params).then(
            (result) => {
              client?.send({
                ...(id === undefined ? {} : { id }),
                type: 'response',
                payload: { result },
              })
            },
            (error: unknown) => {
              client?.send({
                ...(id === undefined ? {} : { id }),
                type: 'error',
                payload: {
                  code: error instanceof HandlerError ? error.code : 'internal.error',
                  message: error instanceof Error ? error.message : String(error),
                },
              })
            },
          )
        }
      },
    })
    client.start()
  }
  startClient()

  const requireClient = (): RelayClient => {
    if (client === undefined || !client.connected) throw new Error('relay not connected')
    return client
  }

  const resetIdentity = async (): Promise<{ deviceId: string }> => {
    const next = generateIdentity()
    await scope.update({ deviceId: next.deviceId, deviceSecret: next.deviceSecret })
    current = next
    // Reconnect with the new identity: fresh hello mints a new pairing code,
    // and every previously bound session token no longer resolves.
    startClient()
    return { deviceId: next.deviceId }
  }

  new RemoteControlGateway(ctx, {
    pairing: () => state,
    sessions: async () => {
      const reply = await requireClient().request('sessions.list', {})
      if (reply.type === 'error') throw new Error((reply.payload as { message: string }).message)
      return { sessions: (reply.payload as { sessions?: SessionInfo[] }).sessions ?? [] }
    },
    revoke: async (sessionId) => {
      const reply = await requireClient().request('sessions.revoke', { sessionId })
      if (reply.type === 'error') throw new Error((reply.payload as { message: string }).message)
      return { revoked: (reply.payload as { revoked?: boolean }).revoked ?? false }
    },
    resetIdentity,
    testConnection: async () => {
      if (state.error !== undefined) return { ok: false, message: state.error }
      try {
        // One real wire round-trip: a registered device always gets a
        // sessions.list reply, so a reply proves the whole path end to end.
        await requireClient().request('sessions.list', {}, 3_000)
        return { ok: true, message: 'relay reachable' }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  ctx.effect(() => () => {
    client?.stop()
    client = undefined
    void relay?.close()
    relay = undefined
  })
}
