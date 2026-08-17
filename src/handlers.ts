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
      default:
        throw new HandlerError('method.not-found', `unknown remote method: ${method}`)
    }
  }
}
