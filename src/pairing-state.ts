import { toDataURL } from 'qrcode'

export type { PairingSnapshot } from './types.ts'

/** The QR payload the phone scans: relay URL + pairing code. */
export function qrPayload(phoneRelayUrl: string, code: string): string {
  return `relay=${encodeURIComponent(phoneRelayUrl)}&code=${code}`
}

const qrCache = new Map<string, Promise<string>>()
/** Bounded so long-running hosts do not grow the cache with every rotated code. */
const QR_CACHE_MAX = 20

/** Render the QR payload as a PNG data URL, memoized per payload. */
export function qrDataUrl(payload: string): Promise<string> {
  let pending = qrCache.get(payload)
  if (pending === undefined) {
    pending = toDataURL(payload)
    qrCache.set(payload, pending)
    // The size guard above guarantees the first key exists.
    if (qrCache.size > QR_CACHE_MAX) qrCache.delete(qrCache.keys().next().value as string)
  }
  return pending
}
