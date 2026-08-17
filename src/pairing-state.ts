import { toDataURL } from 'qrcode'

export type { PairingSnapshot } from './types.ts'

/** The QR payload the phone scans: relay URL + pairing code. */
export function qrPayload(phoneRelayUrl: string, code: string): string {
  return `relay=${encodeURIComponent(phoneRelayUrl)}&code=${code}`
}

const qrCache = new Map<string, Promise<string>>()

/** Render the QR payload as a PNG data URL, memoized per payload. */
export function qrDataUrl(payload: string): Promise<string> {
  let pending = qrCache.get(payload)
  if (pending === undefined) {
    pending = toDataURL(payload)
    qrCache.set(payload, pending)
  }
  return pending
}
