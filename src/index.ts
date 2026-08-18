import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
// Loader's Context declaration merge provides ctx.loader.
import type {} from '@deepseek-ai/cordis-plugin-loader'
// The agent registry Context merge provides ctx.agents.
import type {} from '@deepseek-ai/dsh-agent'
import type { AgentHandle, Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type { SessionInfo } from '@firefly0621/dsh-remote-protocol'
import { RelayClient } from './relay-client.ts'
import { createHandler, HandlerError, projectHistory, titleOf, type ChatMessage, type SessionSummary } from './handlers.ts'
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

  const state: PairingSnapshot = { status: 'disconnected' }

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
        delete state.error
      },
      onFailure: (error) => {
        state.status = 'error'
        state.error = error.message
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

  /** Clear the pairing code and any error, keeping the address. */
  const resetPairingState = (): void => {
    state.status = 'disconnected'
    delete state.code
    delete state.expiresAt
    delete state.qrDataUrl
    delete state.error
  }

  /** Explicitly connect to the current relay address. */
  const connect = async (): Promise<{ ok: boolean }> => {
    resetPairingState()
    state.status = 'connecting'
    startClient()
    return { ok: true }
  }

  /** Explicitly drop the connection and clear the pairing code. */
  const disconnect = async (): Promise<{ ok: boolean }> => {
    client?.stop()
    client = undefined
    chat = undefined
    resetPairingState()
    return { ok: true }
  }

  /** Point the connection at a new relay address; reconnects only when already active. */
  const reconfigure = async (nextUrl: string): Promise<void> => {
    const active = client !== undefined
    client?.stop()
    client = undefined
    chat = undefined
    resetPairingState()
    relayUrl = nextUrl
    state.relayUrl = relayUrl
    if (active) {
      state.status = 'connecting'
      startClient()
    }
  }

  // Precedence: the panel-persisted address wins, then cordis.yml config, then
  // the local relay default. The plugin stays disconnected until the user
  // presses 连接.
  const stored = scope.get() as { relayUrl?: string } | undefined
  const initialUrl = stored?.relayUrl && stored.relayUrl !== '' ? stored.relayUrl : config.relayUrl ?? DEFAULT_RELAY_URL
  relayUrl = initialUrl
  state.relayUrl = relayUrl

  const requireClient = (): RelayClient => {
    if (client === undefined || !client.connected) throw new Error('relay not connected')
    return client
  }

  /** One in-flight phone chat: its target session and the assistant text so far. */
  let chat: { sessionId: string; buffer: string } | undefined

  const emitEvent = (event: string, payload: unknown): void => {
    client?.send({ type: 'event', payload: { event, payload } })
  }

  /** Sessions the phone can chat with: those with a live agent, most recent first. */
  const sessionsList = async (): Promise<{ sessions: SessionSummary[] }> => {
    const agents = ctx.get('agents')
    if (agents === undefined) return { sessions: [] }
    return {
      sessions: agents.list()
        .map(agent => ({
          sessionId: agent.session.id,
          title: titleOf(agent.session),
          seq: agent.session.seq,
        }))
        .sort((a, b) => b.seq - a.seq),
    }
  }

  /** Handles of sessions this plugin created, so the phone can delete them. */
  const ownedSessions = new Map<SessionId, AgentHandle>()

  /** Create a new session on the default workspace with the default preset. */
  const sessionsCreate = async (): Promise<{ sessionId: string }> => {
    const agents = ctx.get('agents')
    if (agents === undefined) throw new HandlerError('sessions.unavailable', 'no agent loop on this host')
    const sessionId = randomUUID() as SessionId
    const defaults = ctx.get('agentDefaultModel')
    const presets = ctx.get('agentPresets')
    const handle = await agents.create({
      sessionId,
      ...(defaults === undefined ? {} : { agentOptions: defaults.currentSelection() }),
      // The phone has no workspace concept yet; the harness cwd is the project root.
      meta: { cwd: process.cwd() },
      ...(presets === undefined ? {} : { setup: async (agentCtx: Context) => { await presets.mount(agentCtx) } }),
    })
    ownedSessions.set(sessionId, handle)
    return { sessionId }
  }

  /** Delete a session this plugin created; web-created sessions are refused. */
  const sessionsDelete = async (sessionId: string): Promise<{ deleted: boolean }> => {
    const handle = ownedSessions.get(sessionId as SessionId)
    if (handle === undefined) throw new HandlerError('sessions.not-owned', 'only sessions created from this phone can be deleted')
    await handle.dispose()
    ownedSessions.delete(sessionId as SessionId)
    return { deleted: true }
  }

  /** Submit one message to a chosen session (or the most recent active one); the reply streams via `event` pushes. */
  const chatSend = async (text: string, sessionId?: string): Promise<{ accepted: boolean }> => {
    requireClient()
    if (chat !== undefined) throw new HandlerError('chat.busy', 'a chat is already streaming; wait for it to finish')
    // The agent registry is optional: chat is unavailable without it, while
    // inventory/settings/pairing keep working on hosts without an agent loop.
    const agents = ctx.get('agents')
    if (agents === undefined) throw new HandlerError('chat.unavailable', 'no agent loop on this host')
    const live = agents.list()
    const target = sessionId === undefined
      ? [...live].sort((a, b) => b.session.seq - a.session.seq)[0]
      : live.find(agent => agent.session.id === sessionId)
    if (target === undefined) {
      throw new HandlerError('no-session', sessionId === undefined ? 'no active session on this host' : `no active session: ${sessionId}`)
    }
    target.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    chat = { sessionId: target.session.id, buffer: '' }
    emitEvent('chat/start', { sessionId: target.session.id })
    return { accepted: true }
  }

  /** The projected conversation history of one attached session. */
  const chatHistory = async (sessionId: string): Promise<{ messages: ChatMessage[] }> => {
    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    const session = agents?.list().find(agent => agent.session.id === sessionId)?.session
      ?? sessions?.get(sessionId as SessionId)
    if (session === undefined) throw new HandlerError('no-session', `no session: ${sessionId}`)
    return { messages: projectHistory(session.events) }
  }

  /** Per-agent model selection installed by this plugin (one waterfall per agent). */
  const modelSelections = new WeakMap<Agent, ModelSelectionRef>()
  const selectionFor = (agent: Agent): ModelSelectionRef => {
    let ref = modelSelections.get(agent)
    if (ref === undefined) {
      ref = { current: undefined, assembled: undefined }
      installModelSelection(agent.ctx, ref)
      modelSelections.set(agent, ref)
    }
    return ref
  }

  /** The available provider/model catalog, plus the host default selection. */
  const modelsList = async (): Promise<{
    groups: Array<{ provider: string; models: string[] }>
    current?: { provider: string; model: string }
  }> => {
    const llm = ctx.get('llm')
    if (llm === undefined) throw new HandlerError('models.unavailable', 'no LLM service on this host')
    const groups = await Promise.all(llm.listProviders().map(async provider => ({
      provider: provider.id,
      models: (await llm.listModels(provider.id)).map(model => model.id),
    })))
    const defaults = ctx.get('agentDefaultModel')
    return {
      groups,
      ...(defaults === undefined ? {} : { current: defaults.currentSelection() }),
    }
  }

  /** Set the model selection of one live session. */
  const modelsSet = async (sessionId: string, provider: string, model: string): Promise<{ ok: boolean }> => {
    const agents = ctx.get('agents')
    const agent = agents?.list().find(candidate => candidate.session.id === sessionId)
    if (agent === undefined) throw new HandlerError('no-session', `no active session: ${sessionId}`)
    selectionFor(agent).current = { provider, model }
    return { ok: true }
  }

  // Forward the target session's assistant stream to the paired app: text
  // deltas as chat/chunk, the terminal turn as chat/done or chat/error.
  ctx.on('session/event', (session, event) => {
    if (chat === undefined || session.id !== chat.sessionId) return
    if (event.type === 'assistant/chunk') {
      if (event.data.chunk.type === 'text-delta') {
        chat.buffer += event.data.chunk.text
        emitEvent('chat/chunk', { text: event.data.chunk.text })
      }
    } else if (event.type === 'turn/end') {
      if (event.data.reason.kind === 'completed') emitEvent('chat/done', { text: chat.buffer })
      else emitEvent('chat/error', { code: 'turn-not-completed', message: event.data.reason.kind })
      chat = undefined
    }
  })

  const handler = createHandler({
    loader: ctx.loader,
    settings: ctx.settings,
    sessions: { list: sessionsList, create: sessionsCreate, delete: sessionsDelete },
    chat: { history: chatHistory, send: chatSend },
    models: { list: modelsList, set: modelsSet },
  })

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
    connect,
    disconnect,
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
