import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { qrDataUrl, qrPayload } from './pairing-state.ts'
import type {
  ConnectionActionSnapshot,
  PairingSnapshot,
  ResetIdentitySnapshot,
  RevokeSnapshot,
  SessionsSnapshot,
  SetRelayUrlSnapshot,
  TestConnectionSnapshot,
} from './types.ts'

export type {
  ConnectionActionSnapshot,
  PairingSnapshot,
  ResetIdentitySnapshot,
  RevokeSnapshot,
  SessionsSnapshot,
  SetRelayUrlSnapshot,
  TestConnectionSnapshot,
} from './types.ts'

/** Host services the gateway reads, narrowed to what the GUI needs. */
export interface RemoteControlGatewayDeps {
  /** Current pairing snapshot, live. */
  pairing(): PairingSnapshot
  /** Explicitly connect to the current relay address. */
  connect(): Promise<ConnectionActionSnapshot>
  /** Explicitly drop the connection and clear the pairing code. */
  disconnect(): Promise<ConnectionActionSnapshot>
  /** Bound app sessions of this device, from the relay. */
  sessions(): Promise<SessionsSnapshot>
  /** Ask the relay to drop one app session. */
  revoke(sessionId: string): Promise<RevokeSnapshot>
  /** Regenerate the identity and reconnect; old sessions are orphaned. */
  resetIdentity(): Promise<ResetIdentitySnapshot>
  /** One explicit wire round-trip against the relay, for the connection test. */
  testConnection(): Promise<TestConnectionSnapshot>
  /** Persist and apply a new relay address; '' selects the local relay at 127.0.0.1:8787. */
  setRelayUrl(url: string): Promise<SetRelayUrlSnapshot>
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
    if (snapshot.code !== undefined && snapshot.relayUrl !== undefined) {
      // Memoize the rendered QR on the live snapshot per code.
      snapshot.qrDataUrl = await qrDataUrl(qrPayload(snapshot.relayUrl, snapshot.code))
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

  /** Persist and apply a new relay address from the pairing panel. */
  @Remote('setRelayUrl')
  async setRelayUrl(url: string): Promise<SetRelayUrlSnapshot> {
    return this.deps.setRelayUrl(url)
  }

  /** Explicitly connect to the configured relay. */
  @Remote('connect')
  async connect(): Promise<ConnectionActionSnapshot> {
    return this.deps.connect()
  }

  /** Explicitly disconnect and clear the pairing code. */
  @Remote('disconnect')
  async disconnect(): Promise<ConnectionActionSnapshot> {
    return this.deps.disconnect()
  }
}
