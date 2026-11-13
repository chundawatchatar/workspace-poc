import { z } from 'zod'
import { canonicalDeviceJwk, type DeviceJwk, deviceJwk } from './deviceProof'
import { machineKeyMatches } from './machineKey'
import { fromBase64url } from './tunnel'

// End-to-end encryption between a browser and a machine (REM-2), so a server
// that relays the traffic can neither read nor inject into it. The browser
// signs a fresh P-256 ephemeral key with its device key, the machine answers
// with its own ephemeral key signed by its Ed25519 machine key and bound to
// that one browser hello, and ECDH plus HKDF give one AES-256-GCM key per
// direction. Each sealed message carries a counter that must arrive in order.
// WebCrypto only, so the host and the browser run the same code.

/** The handshake version both hellos carry and both transcripts sign. */
export const E2E_VERSION = 1

const base64url = (length: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${length}}$`))

/** A raw uncompressed P-256 point (65 bytes) as unpadded base64url. */
const ephemeralKey = base64url(87)

/** A 64-byte signature as unpadded base64url. */
const signature = base64url(86)

/** What a browser sends to open an encrypted channel: its device key, a fresh ephemeral key and its signature. */
export const e2eBrowserHello = z.strictObject({
  v: z.literal(E2E_VERSION),
  device: deviceJwk,
  ephemeral: ephemeralKey,
  signature,
})
export type E2eBrowserHello = z.infer<typeof e2eBrowserHello>

/** The machine's answer: its own fresh ephemeral key, signed by the machine key over the browser's hello. */
export const e2eMachineHello = z.strictObject({
  v: z.literal(E2E_VERSION),
  ephemeral: ephemeralKey,
  signature,
})
export type E2eMachineHello = z.infer<typeof e2eMachineHello>

/** The reasons a handshake or a sealed message fails. None names a key, signature, nonce, counter or plaintext. */
export type E2eErrorReason =
  | 'bad signature'
  | 'bad message'
  | 'replayed or out of order'
  | 'counter exhausted'
  | 'version'

/** Every failure of this module, with one of a fixed set of messages. */
export class E2eError extends Error {
  constructor(readonly reason: E2eErrorReason) {
    super(reason)
    this.name = 'E2eError'
  }
}

/** The P-256 JWK fields this module reads. A `JsonWebKey` fits; spelled out for workspaces without DOM types. */
export interface E2eJwk {
  kty?: string
  crv?: string
  x?: string
  y?: string
  d?: string
}

/** A browser's device key: the public JWK and a raw (IEEE P1363) ECDSA P-256 / SHA-256 signer, as `DeviceSigner`. */
export interface E2eDeviceSigner {
  publicJwk: E2eJwk
  sign(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array>
}

/** A machine's key: the raw Ed25519 public key as unpadded base64url, and a signer of raw 64-byte signatures. */
export interface E2eMachineSigner {
  publicKey: string
  sign(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array>
}

/**
 * One side of an encrypted channel. `seal` encrypts the next outgoing message
 * and `open` decrypts the next incoming one; `aad` is extra data both sides
 * must pass alike, bound to the message but not sent with it. The caller
 * closes the channel when `open` rejects.
 */
export interface E2eChannel {
  seal(plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>
  open(sealed: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>
}

/** The highest channel number `E2eSession.channel` takes. */
export const MAX_E2E_CHANNEL = 2 ** 32 - 1

/**
 * An end-to-end session: a channel of its own, plus `channel(n)`, an
 * independent sub-channel for channel number `n` (1 to `MAX_E2E_CHANNEL`), so
 * messages that may arrive in any order (one HTTP request each) never share a
 * counter. Its keys come from the same HKDF base with `n` in the info, and it
 * counts from 0 in each direction. Each `n` can be taken once per session, on
 * either side: a second call rejects with `E2eError`, so a key and IV pair is
 * never used twice and a replayed channel can't be opened again.
 */
export interface E2eSession extends E2eChannel {
  channel(n: number): Promise<E2eChannel>
}

/** What `startBrowserHandshake` gives back: the hello to send and a step that checks the machine's answer. */
export interface BrowserHandshake {
  hello: E2eBrowserHello
  /**
   * Resolves to the session once `reply` checks out against `machinePublicKey`
   * and the machine id, else rejects. Single use: every later call rejects,
   * whatever the first one gave.
   */
  finish(reply: unknown, machinePublicKey: string): Promise<E2eSession>
}

/** What `answerBrowserHandshake` gives back. `device` is the verified device key, for the caller's approval check. */
export interface MachineHandshake {
  reply: E2eMachineHello
  session: E2eSession
  device: DeviceJwk
}

/**
 * Test-only overrides: a fixed ephemeral private key (a P-256 JWK with `d`)
 * and a lower message limit per direction. Not re-exported from the index.
 */
export interface E2eTestHooks {
  ephemeral?: E2eJwk
  maxMessages?: number
}

/** Messages each direction may seal before its counter is used up. */
const MAX_MESSAGES = 2 ** 32 - 1

const BROWSER_CONTEXT = 'orch-e2e-browser'
const MACHINE_CONTEXT = 'orch-e2e-machine'
const BROWSER_TO_MACHINE = 'orch-e2e browser->machine'
const MACHINE_TO_BROWSER = 'orch-e2e machine->browser'

const COUNTER_BYTES = 8
const TAG_BYTES = 16

const encoder = new TextEncoder()
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

/**
 * Starts a handshake from the browser for `machineId`, signing a fresh
 * ephemeral key with `device`. The ephemeral private key never leaves this call.
 */
export function startBrowserHandshake(options: {
  machineId: string
  device: E2eDeviceSigner
}): Promise<BrowserHandshake> {
  return startBrowserHandshakeWith(options, {})
}

/** `startBrowserHandshake` with test hooks. Not re-exported from the index. */
export async function startBrowserHandshakeWith(
  { machineId, device }: { machineId: string; device: E2eDeviceSigner },
  hooks: E2eTestHooks,
): Promise<BrowserHandshake> {
  const { kty, crv, x, y } = device.publicJwk
  const devicePublic = parseMessage(deviceJwk, { kty, crv, x, y })
  const own = await ephemeralPair(hooks)
  const browserTranscript = browserSignedMessage(machineId, devicePublic, own.publicKey)
  const hello: E2eBrowserHello = {
    v: E2E_VERSION,
    device: devicePublic,
    ephemeral: own.publicKey,
    signature: toBase64url(await device.sign(browserTranscript)),
  }
  let finished = false
  return {
    hello,
    finish: async (reply, machinePublicKey) => {
      // Single use, set before the first await: two sessions from one
      // handshake would share keys and counters, so AES-GCM would reuse IVs.
      if (finished) throw new E2eError('bad message')
      finished = true
      const answer = parseMessage(e2eMachineHello, reply)
      const peer = await importEphemeral(answer.ephemeral)
      if (!(await machineKeyMatches(machinePublicKey, machineId))) throw new E2eError('bad signature')
      const machineTranscript = machineSignedMessage(machineId, await sha256(browserTranscript), answer.ephemeral)
      let verifyKey: CryptoKey
      try {
        verifyKey = await crypto.subtle.importKey('raw', fromBase64url(machinePublicKey), 'Ed25519', false, ['verify'])
      } catch {
        throw new E2eError('bad signature')
      }
      const valid = await crypto.subtle.verify('Ed25519', verifyKey, fromBase64url(answer.signature), machineTranscript)
      if (!valid) throw new E2eError('bad signature')
      const keys = await deriveKeys(own.privateKey, peer, browserTranscript, machineTranscript)
      return createSession(keys, 'browser', hooks)
    },
  }
}

/**
 * Answers a browser's `hello` on the machine `machineId`, after checking the
 * device's signature over it, with a fresh ephemeral key signed by `machine`.
 * It doesn't check that the device is approved; the caller does, with `device`.
 */
export function answerBrowserHandshake(options: {
  machineId: string
  machine: E2eMachineSigner
  hello: unknown
}): Promise<MachineHandshake> {
  return answerBrowserHandshakeWith(options, {})
}

/** `answerBrowserHandshake` with test hooks. Not re-exported from the index. */
export async function answerBrowserHandshakeWith(
  { machineId, machine, hello }: { machineId: string; machine: E2eMachineSigner; hello: unknown },
  hooks: E2eTestHooks,
): Promise<MachineHandshake> {
  const browser = parseMessage(e2eBrowserHello, hello)
  const peer = await importEphemeral(browser.ephemeral)
  const browserTranscript = browserSignedMessage(machineId, browser.device, browser.ephemeral)
  let verifyKey: CryptoKey
  try {
    verifyKey = await crypto.subtle.importKey('jwk', browser.device, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify',
    ])
  } catch {
    throw new E2eError('bad message')
  }
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    fromBase64url(browser.signature),
    browserTranscript,
  )
  if (!valid) throw new E2eError('bad signature')

  const own = await ephemeralPair(hooks)
  const machineTranscript = machineSignedMessage(machineId, await sha256(browserTranscript), own.publicKey)
  const machineSignature = await machine.sign(machineTranscript)
  if (machineSignature.length !== 64) throw new E2eError('bad signature')
  const reply: E2eMachineHello = { v: E2E_VERSION, ephemeral: own.publicKey, signature: toBase64url(machineSignature) }
  const keys = await deriveKeys(own.privateKey, peer, browserTranscript, machineTranscript)
  return {
    reply,
    session: createSession(keys, 'machine', hooks),
    device: browser.device,
  }
}

/**
 * The bytes the browser signs: its context, the version, the machine id, its
 * device key (`canonicalDeviceJwk`) and its ephemeral key, one per line. The
 * device key is in it so a hello re-signed under another device key yields a
 * transcript, and so a machine answer, that the real browser refuses.
 */
function browserSignedMessage(machineId: string, device: DeviceJwk, ephemeral: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${BROWSER_CONTEXT}\n${E2E_VERSION}\n${machineId}\n${canonicalDeviceJwk(device)}\n${ephemeral}`)
}

/**
 * The bytes the machine signs: its context, the version, the machine id, the
 * SHA-256 of the browser's signed bytes and its own ephemeral key, one per line.
 */
function machineSignedMessage(
  machineId: string,
  browserDigest: Uint8Array,
  ephemeral: string,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${MACHINE_CONTEXT}\n${E2E_VERSION}\n${machineId}\n${toBase64url(browserDigest)}\n${ephemeral}`)
}

/** Parses a hello, telling another version apart from a malformed message. */
function parseMessage<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const version = typeof value === 'object' && value !== null ? (value as { v?: unknown }).v : undefined
  throw new E2eError(version !== undefined && version !== E2E_VERSION ? 'version' : 'bad message')
}

/** A fresh non-extractable ECDH key pair, or the hooks' fixed one, with the public half as base64url. */
async function ephemeralPair(hooks: E2eTestHooks): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  if (hooks.ephemeral) {
    const { kty, crv, x, y, d } = hooks.ephemeral
    const privateKey = await crypto.subtle.importKey('jwk', { kty, crv, x, y, d }, ECDH, false, ['deriveBits'])
    const raw = concat(Uint8Array.of(4), fromBase64url(x ?? ''), fromBase64url(y ?? ''))
    return { privateKey, publicKey: toBase64url(raw) }
  }
  const pair = await crypto.subtle.generateKey(ECDH, false, ['deriveBits'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { privateKey: pair.privateKey, publicKey: toBase64url(raw) }
}

/** The peer's ephemeral key, refused unless it is an uncompressed point on P-256. */
async function importEphemeral(ephemeral: string): Promise<CryptoKey> {
  const raw = fromBase64url(ephemeral)
  if (raw.length !== 65 || raw[0] !== 4) throw new E2eError('bad message')
  try {
    return await crypto.subtle.importKey('raw', raw, ECDH, false, [])
  } catch {
    throw new E2eError('bad message')
  }
}

/**
 * The two direction keys: ECDH over the ephemeral keys, then HKDF-SHA-256 with
 * the SHA-256 of both signed transcripts (browser's, a newline, machine's) as
 * salt and each direction's label as info.
 */
async function deriveKeys(
  ownPrivate: CryptoKey,
  peerPublic: CryptoKey,
  browserTranscript: Uint8Array,
  machineTranscript: Uint8Array,
): Promise<DirectionKeys> {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPublic }, ownPrivate, 256)
  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const salt = await sha256(concat(browserTranscript, encoder.encode('\n'), machineTranscript))
  const derive = (label: string) =>
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(label) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  return {
    derive,
    browserToMachine: await derive(BROWSER_TO_MACHINE),
    machineToBrowser: await derive(MACHINE_TO_BROWSER),
  }
}

/** The session's two direction keys, and `derive`, which makes another key from the same HKDF base for a label. */
interface DirectionKeys {
  derive(label: string): Promise<CryptoKey>
  browserToMachine: CryptoKey
  machineToBrowser: CryptoKey
}

/** A direction's label on channel `n`, its HKDF info and AAD label. Unlike a session label, it ends in ` channel <n>`. */
function channelLabel(label: string, n: number): string {
  return `${label} channel ${n}`
}

/** `side`'s session: it seals in its own direction and opens in the peer's, and keeps which channels it has taken. */
function createSession(keys: DirectionKeys, side: 'browser' | 'machine', hooks: E2eTestHooks): E2eSession {
  const [sealLabel, openLabel] =
    side === 'browser' ? [BROWSER_TO_MACHINE, MACHINE_TO_BROWSER] : [MACHINE_TO_BROWSER, BROWSER_TO_MACHINE]
  const [sealKey, openKey] =
    side === 'browser' ? [keys.browserToMachine, keys.machineToBrowser] : [keys.machineToBrowser, keys.browserToMachine]
  const taken = new Set<number>()
  return {
    ...createChannel(sealKey, sealLabel, openKey, openLabel, hooks),
    channel: async (n) => {
      if (!Number.isInteger(n) || n < 1 || n > MAX_E2E_CHANNEL) throw new E2eError('bad message')
      // Taken before the first await, so two concurrent calls for one `n` never both get its keys.
      if (taken.has(n)) throw new E2eError('replayed or out of order')
      taken.add(n)
      const [channelSeal, channelOpen] = [channelLabel(sealLabel, n), channelLabel(openLabel, n)]
      return createChannel(
        await keys.derive(channelSeal),
        channelSeal,
        await keys.derive(channelOpen),
        channelOpen,
        hooks,
      )
    },
  }
}

/** A channel that seals with `sealKey` under `sealLabel` and opens with `openKey` under `openLabel`. */
function createChannel(
  sealKey: CryptoKey,
  sealLabel: string,
  openKey: CryptoKey,
  openLabel: string,
  hooks: E2eTestHooks,
): E2eChannel {
  const maxMessages = hooks.maxMessages ?? MAX_MESSAGES
  let nextSeal = 0
  let nextOpen = 0
  // Opens run one at a time in call order, so a caller that doesn't await one
  // before the next still checks each counter against the right expectation.
  let opening: Promise<unknown> = Promise.resolve()

  const openNext = async (sealed: Uint8Array, aad: Uint8Array | undefined): Promise<Uint8Array> => {
    if (sealed.length < COUNTER_BYTES + TAG_BYTES) throw new E2eError('bad message')
    const counter = readCounter(sealed)
    if (counter !== nextOpen) throw new E2eError('replayed or out of order')
    let plaintext: ArrayBuffer
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv(counter), additionalData: additionalData(openLabel, counter, aad) },
        openKey,
        new Uint8Array(sealed.subarray(COUNTER_BYTES)),
      )
    } catch {
      throw new E2eError('bad message')
    }
    nextOpen = counter + 1
    return new Uint8Array(plaintext)
  }

  return {
    seal: async (plaintext, aad) => {
      // Reserved before the first await, so concurrent seals never share a counter.
      if (nextSeal >= maxMessages) throw new E2eError('counter exhausted')
      const counter = nextSeal++
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv(counter), additionalData: additionalData(sealLabel, counter, aad) },
        sealKey,
        new Uint8Array(plaintext),
      )
      return concat(counterBytes(counter), new Uint8Array(ciphertext))
    },
    open: (sealed, aad) => {
      const result = opening.then(() => openNext(sealed, aad))
      opening = result.catch(() => undefined)
      return result
    },
  }
}

/** The 12-byte AES-GCM IV for `counter`: four zero bytes, then the counter. */
function iv(counter: number): Uint8Array<ArrayBuffer> {
  return concat(new Uint8Array(4), counterBytes(counter))
}

/** The direction's label, a zero byte, the counter and the caller's `aad`. */
function additionalData(label: string, counter: number, aad: Uint8Array | undefined): Uint8Array<ArrayBuffer> {
  return concat(encoder.encode(label), new Uint8Array(1), counterBytes(counter), aad ?? new Uint8Array())
}

/** `counter` as 8 big-endian bytes. */
function counterBytes(counter: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(COUNTER_BYTES)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, Math.floor(counter / 2 ** 32))
  view.setUint32(4, counter >>> 0)
  return bytes
}

/** The counter at the start of a sealed message. */
function readCounter(sealed: Uint8Array): number {
  const view = new DataView(sealed.buffer, sealed.byteOffset, COUNTER_BYTES)
  return view.getUint32(0) * 2 ** 32 + view.getUint32(4)
}

async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)))
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function toBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
