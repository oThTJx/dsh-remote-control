import { settingsNamespace, type SettingsProvider, type SettingsPathOp } from '@deepseek-ai/dsh-settings'

/** Minimal Loader entry view the handler projects. */
interface LoaderEntryLike {
  id: string
  options: { name: string; group?: unknown }
  disabled: boolean
  fiber?: { state: number }
}

const FIBER_PHASE = ['pending', 'loading', 'active', 'failed', 'unloading'] as const

/** Loader entry → wire-safe inventory row. */
function projectEntry(entry: LoaderEntryLike): { entryId: string; moduleName: string; enabled: boolean; fiberPhase: string | null } {
  return {
    entryId: entry.id,
    moduleName: entry.options.name,
    enabled: !entry.disabled,
    fiberPhase: entry.fiber === undefined ? null : (FIBER_PHASE[entry.fiber.state] ?? null),
  }
}

/** One host session as surfaced to the phone. */
export interface SessionSummary {
  sessionId: string
  /** First user message text (truncated), or a placeholder for blank sessions. */
  title: string
  /** Durable event count; higher means more recent activity. */
  seq: number
}

/** One projected conversation entry; tool calls surface as compact rows. */
export type ChatMessage =
  | { role: 'user' | 'assistant'; text: string }
  | { role: 'tool'; name: string; error?: string }

/** Services the command handler needs, narrowed to what it reads. */
export interface HandlerServices {
  loader: { entries(): Iterable<LoaderEntryLike> }
  settings: Pick<SettingsProvider, 'describe' | 'mutate'>
  /** Optional session management over the host's agent registry. */
  sessions?: {
    /** The sessions a phone can chat with (those with a live agent), most recent first. */
    list(): Promise<{ sessions: SessionSummary[] }>
    /** Create a new session; the plugin owns the handle so the phone can delete it later. */
    create(): Promise<{ sessionId: string }>
    /** Delete a session the plugin created; web-created sessions are refused. */
    delete(sessionId: string): Promise<{ deleted: boolean }>
  }
  /** Optional chat: submit one message to a session; the reply streams via `event` pushes. */
  chat?: {
    /** The projected conversation history of one session. */
    history(sessionId: string): Promise<{ messages: ChatMessage[] }>
    /** Submit one message; an absent sessionId picks the most recent active session. */
    send(text: string, sessionId?: string): Promise<{ accepted: boolean }>
  }
  /** Optional model catalog and per-session selection. */
  models?: {
    /** The available provider/model catalog, plus the host default selection. */
    list(): Promise<{ groups: Array<{ provider: string; models: string[] }>; current?: { provider: string; model: string } }>
    /** Set the model selection of one live session. */
    set(sessionId: string, provider: string, model: string): Promise<{ ok: boolean }>
  }
}

/** Stable machine-readable handler errors. */
export class HandlerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HandlerError'
  }
}

/** Dispatch one remote method over the host services. */
export function createHandler(services: HandlerServices): (method: string, params: unknown) => Promise<unknown> {
  return async (method, params) => {
    switch (method) {
      case 'plugin.list': {
        const entries = [...services.loader.entries()].filter(entry => entry.options.group === undefined)
        return { entries: entries.map(projectEntry) }
      }
      case 'settings.describe': {
        return { namespaces: services.settings.describe({ redactSecrets: true }) }
      }
      case 'settings.mutate': {
        const { ns, ops, expectedRevision } = params as { ns: string; ops: SettingsPathOp[]; expectedRevision?: number }
        await services.settings.mutate(settingsNamespace(ns), ops, expectedRevision)
        return { ok: true }
      }
      case 'sessions.list': {
        if (services.sessions === undefined) throw new HandlerError('sessions.unavailable', 'session management is not available in this deployment')
        return services.sessions.list()
      }
      case 'sessions.create': {
        if (services.sessions === undefined) throw new HandlerError('sessions.unavailable', 'session management is not available in this deployment')
        return services.sessions.create()
      }
      case 'sessions.delete': {
        if (services.sessions === undefined) throw new HandlerError('sessions.unavailable', 'session management is not available in this deployment')
        const { sessionId } = params as { sessionId?: unknown }
        if (typeof sessionId !== 'string' || sessionId.length === 0) throw new HandlerError('payload.invalid', 'sessionId must be a string')
        return services.sessions.delete(sessionId)
      }
      case 'chat.history': {
        if (services.chat === undefined) throw new HandlerError('chat.unavailable', 'chat is not available in this deployment')
        const { sessionId } = params as { sessionId?: unknown }
        if (typeof sessionId !== 'string' || sessionId.length === 0) throw new HandlerError('payload.invalid', 'sessionId must be a string')
        return services.chat.history(sessionId)
      }
      case 'chat.send': {
        if (services.chat === undefined) throw new HandlerError('chat.unavailable', 'chat is not available in this deployment')
        const { text, sessionId } = params as { text?: unknown; sessionId?: unknown }
        if (typeof text !== 'string' || text.trim() === '') throw new HandlerError('payload.invalid', 'text must be a non-empty string')
        if (sessionId !== undefined && typeof sessionId !== 'string') throw new HandlerError('payload.invalid', 'sessionId must be a string')
        return services.chat.send(text, sessionId)
      }
      case 'models.list': {
        if (services.models === undefined) throw new HandlerError('models.unavailable', 'model selection is not available in this deployment')
        return services.models.list()
      }
      case 'models.set': {
        if (services.models === undefined) throw new HandlerError('models.unavailable', 'model selection is not available in this deployment')
        const { sessionId, provider, model } = params as { sessionId?: unknown; provider?: unknown; model?: unknown }
        if (typeof sessionId !== 'string' || typeof provider !== 'string' || typeof model !== 'string' || sessionId.length === 0 || provider.length === 0 || model.length === 0) {
          throw new HandlerError('payload.invalid', 'sessionId, provider, and model must be non-empty strings')
        }
        return services.models.set(sessionId, provider, model)
      }
      default:
        throw new HandlerError('method.not-found', `unknown remote method: ${method}`)
    }
  }
}
