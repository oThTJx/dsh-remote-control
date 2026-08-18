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

/** Services the command handler needs, narrowed to what it reads. */
export interface HandlerServices {
  loader: { entries(): Iterable<LoaderEntryLike> }
  settings: Pick<SettingsProvider, 'describe' | 'mutate'>
  /** Optional chat: submit one message to a session; the reply streams via `event` pushes. */
  chat?: { send(text: string): Promise<{ accepted: boolean }> }
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
      case 'chat.send': {
        if (services.chat === undefined) throw new HandlerError('chat.unavailable', 'chat is not available in this deployment')
        const { text } = params as { text?: unknown }
        if (typeof text !== 'string' || text.trim() === '') throw new HandlerError('payload.invalid', 'text must be a non-empty string')
        return services.chat.send(text)
      }
      default:
        throw new HandlerError('method.not-found', `unknown remote method: ${method}`)
    }
  }
}
