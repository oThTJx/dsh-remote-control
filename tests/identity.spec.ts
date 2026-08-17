import { describe, expect, it } from 'vitest'
import { generateIdentity, pickIdentity, type Identity } from '../src/identity.ts'

describe('remote-control identity', () => {
  it('generates a dashless uuid deviceId and a 64-hex secret', () => {
    const identity = generateIdentity()
    expect(identity.deviceId).toMatch(/^[0-9a-f]{32}$/)
    expect(identity.deviceSecret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('prefers explicit config over the persisted identity', () => {
    const stored: Identity = { deviceId: 'stored-id', deviceSecret: 'stored-secret' }
    const result = pickIdentity({ deviceId: 'cfg-id', deviceSecret: 'cfg-secret' }, stored, generateIdentity)
    expect(result.identity).toEqual({ deviceId: 'cfg-id', deviceSecret: 'cfg-secret' })
    expect(result.changed).toBe(false)
  })

  it('falls back to the persisted identity', () => {
    const stored: Identity = { deviceId: 'stored-id', deviceSecret: 'stored-secret' }
    const result = pickIdentity({}, stored, generateIdentity)
    expect(result.identity).toEqual(stored)
    expect(result.changed).toBe(false)
  })

  it('generates and reports a change when nothing is persisted', () => {
    const generated: Identity = { deviceId: 'new-id', deviceSecret: 'new-secret' }
    const result = pickIdentity({}, undefined, () => generated)
    expect(result.identity).toEqual(generated)
    expect(result.changed).toBe(true)
  })

  it('fills a missing half from generation', () => {
    const result = pickIdentity(
      { deviceId: 'cfg-id' },
      undefined,
      () => ({ deviceId: 'g-id', deviceSecret: 'g-secret' }),
    )
    expect(result.identity).toEqual({ deviceId: 'cfg-id', deviceSecret: 'g-secret' })
    expect(result.changed).toBe(true)
  })
})
