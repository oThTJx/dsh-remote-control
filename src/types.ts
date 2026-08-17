import type { SessionInfo } from '@firefly0621/dsh-remote-protocol'

/** Pairing status exposed to the web GUI. The gateway memoizes `qrDataUrl` in place. */
export interface PairingSnapshot {
  /** Relay connection state; `error` carries a message in `error`. */
  status: 'connecting' | 'pairing' | 'error'
  /** Effective relay URL, shown to the phone and encoded in the QR. */
  relayUrl?: string
  /** Current 6-digit pairing code, when the relay has issued one. */
  code?: string
  /** Code expiry epoch ms, when a code is live. */
  expiresAt?: number
  /** PNG data URL of the QR encoding the relay URL and code. */
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

/** Result of an explicit relay connection test, surfaced to the pairing panel. */
export interface TestConnectionSnapshot {
  readonly ok: boolean
  readonly message: string
}

/** Result of updating the live relay address from the pairing panel. */
export interface SetRelayUrlSnapshot {
  readonly ok: boolean
}
