import type { SessionInfo } from '@firefly0621/dsh-remote-protocol'

/** Pairing status exposed to the web GUI. The gateway memoizes `qrDataUrl` in place. */
export interface PairingSnapshot {
  /** Relay connection state; `error` carries a message in `error`. */
  status: 'connecting' | 'pairing' | 'error'
  /** Current 6-digit pairing code, when the relay has issued one. */
  code?: string
  /** Code expiry epoch ms, when a code is live. */
  expiresAt?: number
  /** Phone-reachable relay URL the code pairs against. */
  phoneRelayUrl?: string
  /** PNG data URL of the QR encoding the phone-reachable URL and code. */
  qrDataUrl?: string
  /** Human-readable failure, when `status` is `error`. */
  error?: string
}

/** Bound app sessions of this device, as surfaced to the GUI. */
export interface SessionsSnapshot {
  readonly sessions: readonly SessionInfo[]
}

/** Result of revoking one app session. */
export interface RevokeSnapshot {
  readonly revoked: boolean
}

/** Result of regenerating the device identity. */
export interface ResetIdentitySnapshot {
  readonly deviceId: string
}
