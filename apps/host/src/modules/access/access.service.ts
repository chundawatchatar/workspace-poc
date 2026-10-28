import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { formatConnectFragment, type RotateAccessResponse } from '@orch/shared'
import type { Principal } from '../../lib/principal'
import type { AccessKey, AccessKeyRepository } from './access.repository'

/** The name of the key the host creates on its first tunneled start and on every rotation. */
export const DEFAULT_KEY_NAME = 'default'

/** How often, at most, `lastUsedAt` changes are written to disk. */
export const LAST_USED_PERSIST_MS = 60_000

/** The length of a key: 32 random bytes as unpadded base64url. */
const KEY_LENGTH = 43

/** SHA-256 of `value`, as raw bytes. */
function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/**
 * The id the server gives the machine with `secret`: SHA-256 of the secret,
 * as unpadded base64url. It must match the server's derivation.
 */
export function machineIdFromSecret(secret: string): string {
  return sha256(secret).toString('base64url')
}

/** The connect link for `key`: `<clientUrl>/#machine=<id>&key=<key>`. */
export function connectLink(clientUrl: string, machineId: string, key: string): string {
  return `${clientUrl.replace(/\/+$/, '')}/${formatConnectFragment({ machineId, key })}`
}

/** A `CLIENT_URL` value as a client URL, or null unless it is an `http:` or `https:` URL without credentials. */
export function parseClientUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * The client URL a `SERVER_URL` implies: `wss:` becomes `https:` and `ws:`
 * becomes `http:`, keeping the host, port and base path. Null for any other value.
 */
export function clientUrlFromServerUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const protocol = { 'wss:': 'https:', 'ws:': 'http:' }[url.protocol]
  if (!protocol || !url.host) return null
  return `${protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

export interface AccessKeysOptions {
  /** Told which key ids a rotation revoked, so their open sessions can be closed. */
  onRevoked?: (keyIds: string[]) => void
  now?: () => Date
  persistEveryMs?: number
}

/**
 * The host's access keys. `authorize` is the one place the host decides
 * whether a tunneled request or channel may in. Only hashes are kept, in
 * memory and on disk; a raw key exists only in what `create` and `rotate`
 * return.
 */
export class AccessKeys {
  private keys: AccessKey[]
  /** Each key's stored hash as bytes, decoded once. */
  private digests = new Map<string, Buffer>()
  private dirty = false
  private timer: Timer | undefined
  private readonly now: () => Date
  private readonly persistEveryMs: number

  /** Loads the keys from `repository`, which throws for a file that is not valid. */
  constructor(
    private readonly repository: AccessKeyRepository,
    private readonly options: AccessKeysOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.persistEveryMs = options.persistEveryMs ?? LAST_USED_PERSIST_MS
    this.keys = repository.load()
    this.index()
  }

  /** The number of stored keys. */
  get size(): number {
    return this.keys.length
  }

  /**
   * The principal of the stored key matching `key`, or null for a missing,
   * empty, wrong or wrong-length key. Every stored hash is compared in constant
   * time, even after a match. A match records `lastUsedAt`, written to disk at
   * most once per `persistEveryMs` and on `flush()`.
   */
  authorize(key: string | null): Principal | null {
    if (!key || key.length !== KEY_LENGTH) return null
    const digest = sha256(key)
    let match: AccessKey | null = null
    for (const stored of this.keys) {
      const expected = this.digests.get(stored.id)
      const equal = expected !== undefined && expected.length === digest.length && timingSafeEqual(digest, expected)
      if (equal && !match) match = stored
    }
    if (!match) return null
    match.lastUsedAt = this.now().toISOString()
    this.markDirty()
    return { keyId: match.id, name: match.name }
  }

  /** Adds a key named `name`, saves it and returns the raw key. It cannot be read back later. */
  create(name: string): string {
    const { key, stored } = this.newKey(name)
    this.replace([...this.keys, stored])
    return key
  }

  /**
   * Replaces every key with a new `default` key and saves it. Returns the raw
   * key and the ids it revoked, which `onRevoked` is also told.
   */
  rotate(): { key: string; revoked: string[] } {
    const revoked = this.keys.map((stored) => stored.id)
    const { key, stored } = this.newKey(DEFAULT_KEY_NAME)
    this.replace([stored])
    this.options.onRevoked?.(revoked)
    return { key, revoked }
  }

  /** Writes pending `lastUsedAt` changes now, for shutdown. */
  flush() {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.dirty) return
    this.dirty = false
    this.repository.save(this.keys)
  }

  private newKey(name: string): { key: string; stored: AccessKey } {
    const key = randomBytes(32).toString('base64url')
    const stored: AccessKey = {
      id: crypto.randomUUID(),
      name,
      hash: sha256(key).toString('base64url'),
      createdAt: this.now().toISOString(),
      lastUsedAt: null,
    }
    return { key, stored }
  }

  /** Saves `next` first, so a failed write leaves the keys in memory as they were. */
  private replace(next: AccessKey[]) {
    this.repository.save(next)
    this.keys = next
    this.index()
    clearTimeout(this.timer)
    this.timer = undefined
    this.dirty = false
  }

  private index() {
    this.digests = new Map(this.keys.map((stored) => [stored.id, Buffer.from(stored.hash, 'base64url')]))
  }

  private markDirty() {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      try {
        this.flush()
      } catch (error) {
        console.error(`saving access key use failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
    }, this.persistEveryMs)
    // A pending write must not keep the process alive; shutdown flushes it.
    this.timer.unref?.()
  }
}

/** What the rotate route needs: the keys, and what goes into a connect link. */
export interface RemoteAccess {
  keys: AccessKeys
  machineId: string
  /** Null means no client URL is known, so no link can be built. */
  clientUrl: string | null
}

/** Rotates the key and describes the new one, with its connect link when a client URL is known. */
export function rotateAccess({ keys, machineId, clientUrl }: RemoteAccess): RotateAccessResponse {
  const { key } = keys.rotate()
  return { machineId, key, link: clientUrl ? connectLink(clientUrl, machineId, key) : null }
}
