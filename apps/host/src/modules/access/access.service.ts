import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Principal } from '../../lib/principal'
import type { AccessKey, AccessKeyRepository } from './access.repository'

/** How often, at most, `lastUsedAt` changes are written to disk. */
export const LAST_USED_PERSIST_MS = 60_000

/** The length of a key: 32 random bytes as unpadded base64url. */
const KEY_LENGTH = 43

/** SHA-256 of `value`, as raw bytes. */
function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
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
  now?: () => Date
  persistEveryMs?: number
}

/**
 * The host's saved access keys. `authorize` is the one place the host decides
 * whether a tunneled request or channel may in with a key. The host no longer
 * issues keys; it only reads the ones already in `access-keys.json`. Only
 * hashes are kept, in memory and on disk.
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
    options: AccessKeysOptions = {},
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
  authorize(key: string | null): Omit<Extract<Principal, { kind: 'key' }>, 'deviceId'> | null {
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
    return { kind: 'key', keyId: match.id, name: match.name }
  }

  /**
   * Adds a key named `name`, saves it and returns the raw key. It cannot be read back later. Nothing in the host
   * calls it any more; tests use it to seed a saved key.
   */
  create(name: string): string {
    const { key, stored } = this.newKey(name)
    this.replace([...this.keys, stored])
    return key
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
