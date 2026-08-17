import type { Context } from '@deepseek-ai/cordis'
// Loader's Context declaration merge provides ctx.loader.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type { SessionInfo } from '@firefly0621/dsh-remote-protocol'
import { RelayClient } from './relay-client.ts'
import { createHandler, HandlerError } from './handlers.ts'
import { resolveIdentity, generateIdentity, type Identity } from './identity.ts'
import { RemoteControlGateway } from './gateway.ts'
import type { PairingSnapshot } from './pairing-state.ts'

/** Conventional address of a locally running relay; override via relayUrl or the pairing panel. */
export const DEFAULT_RELAY_URL = 'ws://127.0.0.1:8787'

/** Plugin config; everything is optional — an identity is auto-generated and the relay defaults to localhost. */
export interface Config {
  /** Public relay WSS URL, e.g. wss://relay.example.com; absent defaults to a local relay on 127.0.0.1:8787. */
  relayUrl?: string
  /** Stable device id; auto-generated and persisted when absent. */
  deviceId?: string
  /** Long-lived secret registered on the relay for this deviceId; auto-generated and persisted when absent. */
  deviceSecret?: string
}

export const name = 'remote-control'

export const inject = ['settings', 'loader']

export const Config: z<Config> = z.object({
  relayUrl: z.string(),
  deviceId: z.string(),
  deviceSecret: z.string().role('secret'),
})

/** Serve remote commands over the outbound relay connection. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const { identity, scope } = resolveIdentity(ctx, config)
  let current: Identity = identity

  const state: PairingSnapshot = { status: 'connecting' }

  const handler = createHandler({
    loader: ctx.loader,
    settings: ctx.settings,
  })

  let client: RelayClient | undefined
  let relayUrl = DEFAULT_RELAY_URL

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

  /** Point the connection at a new relay address, tearing down the previous client first. */
  const reconfigure = async (nextUrl: string): Promise<void> => {
    client?.stop()
    client = undefined
    state.status = 'connecting'
    delete state.code
    delete state.expiresAt
    delete state.qrDataUrl
    delete state.error
    relayUrl = nextUrl
    state.relayUrl = relayUrl
    startClient()
  }

  // Precedence: the panel-persisted address wins, then cordis.yml config, then
  // the local relay default.
  const stored = scope.get() as { relayUrl?: string } | undefined
  const initialUrl = stored?.relayUrl && stored.relayUrl !== '' ? stored.relayUrl : config.relayUrl ?? DEFAULT_RELAY_URL
  await reconfigure(initialUrl)

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
    await reconfigure(relayUrl)
    return { deviceId: next.deviceId }
  }

  const setRelayUrl = async (url: string): Promise<{ ok: boolean }> => {
    const next = url === '' ? DEFAULT_RELAY_URL : url
    await scope.update({ relayUrl: next })
    await reconfigure(next)
    return { ok: true }
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
    setRelayUrl,
  })

  ctx.effect(() => () => {
    client?.stop()
    client = undefined
  })
}
