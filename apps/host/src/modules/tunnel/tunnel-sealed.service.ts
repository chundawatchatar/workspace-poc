import {
  CLOSE_E2E_SESSION_UNKNOWN,
  decodeEnvelope,
  decodeSocketMessageRecord,
  decodeSocketOpenRecord,
  type E2eChannel,
  type E2eSocketMessage,
  type E2eSocketOpen,
  encodeSocketMessageRecord,
  MAX_TUNNEL_FRAME_BYTES,
  wsPayloadBytes,
} from '@orch/shared'
import type { Principal } from '../../lib/principal'
import type { SealedSessionLookup } from './tunnel-http.service'

// The end-to-end side of the tunnel's sealed sockets (REM-2), apart from the
// channel bookkeeping in `tunnel-channels.service.ts`.

/** Close code for a sealed channel whose envelope, open record or later payload is malformed or doesn't open. */
export const CLOSE_POLICY = 1008

/** The most a `ws.data` frame adds to its payload: the length prefix and the JSON header. */
const FRAME_OVERHEAD_BYTES = 64

/** A sealed record's 8-byte counter and 16-byte tag. */
const SEAL_OVERHEAD = 24

/**
 * The end-to-end side of a channel `ws.sealed` opened. Its payloads are
 * opened, and its messages sealed, each strictly in order, since WebCrypto
 * promises may settle out of order.
 */
export class SealedChannel {
  /** The session's channel the envelope named. Null until the open record has opened. */
  e2e: E2eChannel | null = null
  /** Settles once the open and every payload received so far have been handled, in order. */
  inbound: Promise<void> = Promise.resolve()
  /** Payload bytes received and not yet handed over. */
  inboundBytes = 0
  /** Sealed bytes of the messages still being sealed. */
  sealing = 0
  private outbound: Promise<void> = Promise.resolve()

  /**
   * Opens `payload` after the open and every earlier payload, then hands its
   * message to `deliver`, or calls `fail` for text or a record that doesn't
   * open, comes out of order or isn't a message. Nothing runs once `live` is false.
   */
  receive(
    payload: string | Uint8Array,
    live: () => boolean,
    deliver: (message: E2eSocketMessage, bytes: number) => void,
    fail: () => void,
  ) {
    const bytes = typeof payload === 'string' ? wsPayloadBytes(payload) : payload.byteLength
    this.inboundBytes += bytes
    this.inbound = this.inbound.then(async () => {
      if (!live() || !this.e2e) return
      const message = await openSealedMessage(this.e2e, payload)
      this.inboundBytes -= bytes
      if (!live()) return
      if (message === null) fail()
      else deliver(message, bytes)
    })
  }

  /**
   * Seals `record` after every earlier message and hands the result to
   * `write`, or calls `fail` when sealing fails. `sealing` counts it meanwhile.
   */
  seal(record: Uint8Array, live: () => boolean, write: (sealed: Uint8Array<ArrayBuffer>) => void, fail: () => void) {
    const { e2e } = this
    if (!e2e) return
    const size = sealedSize(record)
    this.sealing += size
    this.outbound = this.outbound.then(async () => {
      if (!live()) return
      const out = await e2e.seal(record).catch(() => null)
      this.sealing -= size
      if (!live()) return
      if (out) write(out as Uint8Array<ArrayBuffer>)
      else fail()
    })
  }
}

/**
 * What opening an envelope gave: the channel, its open record and who opened the session, `'no_auth'` for a record
 * that opened but isn't a valid open record, or the close it gets.
 */
export type SealedOpen =
  | { ok: true; e2e: E2eChannel; record: E2eSocketOpen; owner: Principal }
  | { ok: false; refused: 'no_auth' }
  | { ok: false; code: number; reason: string }

/**
 * Opens a sealed socket's envelope: it reads it, looks up the session it
 * names, takes the channel it names and opens its open record. A session the
 * host doesn't have gets `CLOSE_E2E_SESSION_UNKNOWN`; a malformed envelope, a
 * channel already taken (by a request or a socket, a replay included) or a
 * record that doesn't open gets 1008. A record that opens but isn't a valid
 * open record, such as one whose auth message presents an access key, is
 * `'no_auth'`. Reasons are fixed strings.
 */
export async function openSealedChannel(data: Uint8Array, sessions: SealedSessionLookup): Promise<SealedOpen> {
  let envelope: ReturnType<typeof decodeEnvelope>
  try {
    envelope = decodeEnvelope(data)
  } catch {
    return { ok: false, code: CLOSE_POLICY, reason: 'bad envelope' }
  }
  const entry = sessions(envelope.sessionId)
  if (!entry) return { ok: false, code: CLOSE_E2E_SESSION_UNKNOWN, reason: 'e2e session unknown' }
  let e2e: E2eChannel
  let plaintext: Uint8Array
  try {
    e2e = await entry.session.channel(envelope.channel)
    plaintext = await e2e.open(envelope.sealed)
  } catch {
    return { ok: false, code: CLOSE_POLICY, reason: 'bad envelope' }
  }
  try {
    return { ok: true, e2e, record: decodeSocketOpenRecord(plaintext), owner: entry.principal }
  } catch {
    return { ok: false, refused: 'no_auth' }
  }
}

/** The message a sealed payload carries, or null for text, or a record that doesn't open, comes out of order or isn't a message. */
async function openSealedMessage(e2e: E2eChannel, payload: string | Uint8Array): Promise<E2eSocketMessage | null> {
  if (typeof payload === 'string') return null
  try {
    return decodeSocketMessageRecord(await e2e.open(payload))
  } catch {
    return null
  }
}

/**
 * The message record for `message`, or null when it doesn't fit: the sealed
 * record must fit in one `ws.data` frame, with room for the frame's header.
 */
export function sealableRecord(message: E2eSocketMessage): Uint8Array<ArrayBuffer> | null {
  let record: Uint8Array<ArrayBuffer>
  try {
    record = encodeSocketMessageRecord(message)
  } catch {
    return null
  }
  return sealedSize(record) + FRAME_OVERHEAD_BYTES <= MAX_TUNNEL_FRAME_BYTES ? record : null
}

/** The size of `record` once sealed, as it counts in the channel's window. */
export function sealedSize(record: Uint8Array): number {
  return record.byteLength + SEAL_OVERHEAD
}
