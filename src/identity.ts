import { randomBytes, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { Config } from './index.ts'

/** The host identity a device presents to the relay. */
export interface Identity {
  deviceId: string
  deviceSecret: string
}

/** Settings namespace holding the auto-generated identity. */
export const IDENTITY_NS = settingsNamespace('remote-control')

/** Identity namespace schema; the secret is redacted on every wire surface. */
export const IDENTITY_SCHEMA = z.object({
  deviceId: z.string(),
  deviceSecret: z.string().role('secret'),
})

/** Generate a fresh random identity: dashless uuid + 256-bit hex secret. */
export function generateIdentity(): Identity {
  return { deviceId: randomUUID().replaceAll('-', ''), deviceSecret: randomBytes(32).toString('hex') }
}

/**
 * Pure precedence: explicit config wins per field, then the persisted identity,
 * then generation. `changed` reports whether the result differs from `stored`.
 */
export function pickIdentity(
  config: Config,
  stored: Identity | undefined,
  generate: () => Identity,
): { identity: Identity; changed: boolean } {
  const deviceId = config.deviceId ?? stored?.deviceId
  const deviceSecret = config.deviceSecret ?? stored?.deviceSecret
  if (deviceId !== undefined && deviceSecret !== undefined) {
    return { identity: { deviceId, deviceSecret }, changed: false }
  }
  const generated = generate()
  return {
    identity: { deviceId: deviceId ?? generated.deviceId, deviceSecret: deviceSecret ?? generated.deviceSecret },
    changed: true,
  }
}

/**
 * Resolve the plugin's identity: register the identity settings namespace,
 * apply the precedence chain, and persist a generated identity on first use.
 */
export function resolveIdentity(ctx: Context, config: Config) {
  const scope = registerIdentityScope(ctx)
  const stored = scope.get() as Identity | undefined
  const { identity, changed } = pickIdentity(config, stored, generateIdentity)
  if (changed) void scope.update(identity)
  return { identity, scope }
}

/** Register the identity namespace on the calling plugin's fiber. */
export function registerIdentityScope(ctx: Context): SettingsScope<{ deviceId: string; deviceSecret: string }> {
  return ctx.settings.register(IDENTITY_NS, IDENTITY_SCHEMA)
}
