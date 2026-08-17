import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteControlGateway, type RemoteControlGatewayDeps } from '../src/gateway.ts'

function deps(overrides?: Partial<RemoteControlGatewayDeps>): RemoteControlGatewayDeps {
  return {
    pairing: () => ({
      status: 'pairing',
      code: '123456',
      expiresAt: 1_000_000,
      relayUrl: 'ws://relay.example.com',
    }),
    connect: async () => ({ ok: true }),
    disconnect: async () => ({ ok: true }),
    sessions: async () => ({ sessions: [] }),
    revoke: async () => ({ revoked: true }),
    resetIdentity: async () => ({ deviceId: 'fresh-id' }),
    testConnection: async () => ({ ok: true, message: 'relay reachable' }),
    setRelayUrl: async () => ({ ok: true }),
    ...overrides,
  }
}

describe('RemoteControlGateway', () => {
  it('registers the remoteControl service with a typert binding', () => {
    const ctx = new Context()
    const gateway = new RemoteControlGateway(ctx, deps())
    expect(gateway.typertRemote.serviceKey).toBe('remoteControl')
    const svc = ctx.get('remoteControl') as RemoteControlGateway
    expect(svc.typertRemote.serviceKey).toBe('remoteControl')
    expect(typeof svc.pairing).toBe('function')
  })

  it('returns the pairing snapshot with a QR data URL', async () => {
    const ctx = new Context()
    const gateway = new RemoteControlGateway(ctx, deps())
    const snapshot = await gateway.pairing()
    expect(snapshot.code).toBe('123456')
    expect(snapshot.qrDataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('revokes a session and resets identity through the deps', async () => {
    const ctx = new Context()
    const gateway = new RemoteControlGateway(ctx, deps())
    expect(await gateway.revoke('token-1')).toEqual({ revoked: true })
    expect(await gateway.resetIdentity()).toEqual({ deviceId: 'fresh-id' })
  })

  it('passes the connection test through the deps', async () => {
    const ctx = new Context()
    const gateway = new RemoteControlGateway(ctx, deps({
      testConnection: async () => ({ ok: false, message: 'relay not connected' }),
    }))
    expect(await gateway.testConnection()).toEqual({ ok: false, message: 'relay not connected' })
  })

  it('passes the relay address update through the deps', async () => {
    const ctx = new Context()
    const gateway = new RemoteControlGateway(ctx, deps())
    expect(await gateway.setRelayUrl('wss://relay.example.com')).toEqual({ ok: true })
  })

  it('passes connect and disconnect through the deps', async () => {
    const ctx = new Context()
    const gateway = new RemoteControlGateway(ctx, deps())
    expect(await gateway.connect()).toEqual({ ok: true })
    expect(await gateway.disconnect()).toEqual({ ok: true })
  })
})
