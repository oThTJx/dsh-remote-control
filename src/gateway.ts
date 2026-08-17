import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { qrDataUrl, qrPayload } from './pairing-state.ts'
import type {
  PairingSnapshot,
  ResetIdentitySnapshot,
  RevokeSnapshot,
  SessionsSnapshot,
  TestConnectionSnapshot,
} from './types.ts'

export type {
  PairingSnapshot,
  ResetIdentitySnapshot,
  RevokeSnapshot,
  SessionsSnapshot,
  TestConnectionSnapshot,
} from './types.ts'

/** Host services the gateway reads, narrowed to what the GUI needs. */
export interface RemoteControlGatewayDeps {
  /** Current pairing snapshot, live. */
  pairing(): PairingSnapshot
  /** Bound app sessions of this device, from the relay. */
  sessions(): Promise<SessionsSnapshot>
  /** Ask the relay to drop one app session. */
  revoke(sessionId: string): Promise<RevokeSnapshot>
  /** Regenerate the identity and reconnect; old sessions are orphaned. */
  resetIdentity(): Promise<ResetIdentitySnapshot>
  /** One explicit wire round-trip against the relay, for the connection test. */
  testConnection(): Promise<TestConnectionSnapshot>
}

/** Remote-only service exposing pairing status and session management to the web GUI. */
export class RemoteControlGateway extends TypertRemoteService {
  constructor(ctx: Context, private readonly deps: RemoteControlGatewayDeps) {
    super(ctx, 'remoteControl')
  }

  /** Current pairing snapshot; the QR data URL is rendered on demand. */
  @Remote('pairing')
  async pairing(): Promise<PairingSnapshot> {
    const snapshot = this.deps.pairing()
    if (snapshot.code !== undefined && snapshot.phoneRelayUrl !== undefined) {
      // Memoize the rendered QR on the live snapshot per code.
      snapshot.qrDataUrl = await qrDataUrl(qrPayload(snapshot.phoneRelayUrl, snapshot.code))
    }
    return snapshot
  }

  /** Bound app sessions of this device. */
  @Remote('sessions')
  async sessions(): Promise<SessionsSnapshot> {
    return this.deps.sessions()
  }

  /** Revoke one app session; the phone must pair again. */
  @Remote('revoke')
  async revoke(sessionId: string): Promise<RevokeSnapshot> {
    return this.deps.revoke(sessionId)
  }

  /** Regenerate identity and drop every bound session. */
  @Remote('resetIdentity')
  async resetIdentity(): Promise<ResetIdentitySnapshot> {
    return this.deps.resetIdentity()
  }

  /** Explicit relay connection test; the pairing panel runs it before showing the QR. */
  @Remote('testConnection')
  async testConnection(): Promise<TestConnectionSnapshot> {
    return this.deps.testConnection()
  }
}
