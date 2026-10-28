/** A token bucket's size: it holds up to `capacity` tokens and gains one every `refillEveryMs`. */
export interface BucketLimit {
  capacity: number
  refillEveryMs: number
}

/** The answer to a connection attempt. A refusal says how long until the bucket that refused it has a token. */
export type Admission = { ok: true } | { ok: false; retryAfterSeconds: number }

/** What the limiter needs. Every field has a default, so tests inject only what they change. */
export interface ConnectionLimiterDeps {
  /** Browser requests and sockets per IP. Defaults to 60, refilling 1/s. */
  perIp?: BucketLimit
  /** Browser requests and sockets per machine id. Defaults to 300, refilling 5/s. */
  perMachine?: BucketLimit
  /** Tunnel upgrades per IP. Defaults to 10, refilling 1 per 10 s. */
  tunnelPerIp?: BucketLimit
  /** Rejected access keys per IP. Defaults to 10, refilling 1 per minute. */
  badKeysPerIp?: BucketLimit
  /** How often full buckets are dropped. Defaults to 60 s. */
  sweepIntervalMs?: number
  /** The clock, in milliseconds. Defaults to `Date.now`. */
  now?: () => number
}

interface Bucket {
  tokens: number
  /** When `tokens` was last brought up to date. */
  at: number
}

/** Token buckets of one limit, by key. A key with a full bucket has no entry. */
class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly limit: BucketLimit,
    private readonly now: () => number,
  ) {}

  /** Takes a token for `key`. Returns 0 when it got one, otherwise the milliseconds until one is free. */
  take(key: string): number {
    const bucket = this.refilled(key)
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      this.buckets.set(key, bucket)
      return 0
    }
    return this.waitMs(bucket)
  }

  /** The milliseconds until `key` has a token, without taking one. 0 means it has one now. */
  wait(key: string): number {
    const bucket = this.refilled(key)
    return bucket.tokens >= 1 ? 0 : this.waitMs(bucket)
  }

  /** Drops every bucket that has refilled to capacity, since a missing bucket counts as full. */
  sweep(): void {
    for (const key of [...this.buckets.keys()]) {
      if (this.refilled(key).tokens >= this.limit.capacity) this.buckets.delete(key)
    }
  }

  get size(): number {
    return this.buckets.size
  }

  private refilled(key: string): Bucket {
    const now = this.now()
    const bucket = this.buckets.get(key)
    if (!bucket) return { tokens: this.limit.capacity, at: now }
    bucket.tokens = Math.min(this.limit.capacity, bucket.tokens + (now - bucket.at) / this.limit.refillEveryMs)
    bucket.at = now
    return bucket
  }

  private waitMs(bucket: Bucket): number {
    return Math.ceil((1 - bucket.tokens) * this.limit.refillEveryMs)
  }
}

/**
 * Rate limits for connection attempts, kept in memory for this server only.
 * Browser requests and sockets take a token from their IP's bucket, then from
 * their machine's. Tunnel upgrades have their own per-IP bucket. An IP whose
 * bad-key bucket is empty is refused everywhere until it refills. It sees only
 * IPs, machine ids and `auth.failed` reports, never a key or a relayed request.
 */
export class ConnectionLimiter {
  private readonly perIp: TokenBuckets
  private readonly perMachine: TokenBuckets
  private readonly tunnelPerIp: TokenBuckets
  private readonly badKeys: TokenBuckets
  private readonly sweepIntervalMs: number
  private sweepTimer: Timer | undefined

  constructor({
    perIp = { capacity: 60, refillEveryMs: 1000 },
    perMachine = { capacity: 300, refillEveryMs: 200 },
    tunnelPerIp = { capacity: 10, refillEveryMs: 10_000 },
    badKeysPerIp = { capacity: 10, refillEveryMs: 60_000 },
    sweepIntervalMs = 60_000,
    now = Date.now,
  }: ConnectionLimiterDeps = {}) {
    this.perIp = new TokenBuckets(perIp, now)
    this.perMachine = new TokenBuckets(perMachine, now)
    this.tunnelPerIp = new TokenBuckets(tunnelPerIp, now)
    this.badKeys = new TokenBuckets(badKeysPerIp, now)
    this.sweepIntervalMs = sweepIntervalMs
  }

  /**
   * Admits a browser request or socket from `ip` to `machineId`. An IP that is
   * blocked for bad keys, or out of tokens, is refused before it takes a token
   * from the machine's bucket.
   */
  admitBrowser(ip: string, machineId: string): Admission {
    const blocked = this.badKeys.wait(ip)
    if (blocked > 0) return refused(blocked)
    const ipWait = this.perIp.take(ip)
    if (ipWait > 0) return refused(ipWait)
    const machineWait = this.perMachine.take(machineId)
    return machineWait > 0 ? refused(machineWait) : { ok: true }
  }

  /** Admits a tunnel upgrade from `ip`. */
  admitTunnel(ip: string): Admission {
    const wait = this.tunnelPerIp.take(ip)
    return wait > 0 ? refused(wait) : { ok: true }
  }

  /** Counts a rejected access key against `ip`. An IP already out of bad-key tokens stays blocked. */
  badKey(ip: string): void {
    this.badKeys.take(ip)
  }

  /** Drops full buckets, which includes the bad-key blocks that have run out. */
  sweep(): void {
    this.perIp.sweep()
    this.perMachine.sweep()
    this.tunnelPerIp.sweep()
    this.badKeys.sweep()
  }

  /** Starts sweeping every `sweepIntervalMs`. The timer does not keep the process alive. */
  start(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs)
    this.sweepTimer.unref()
  }

  stop(): void {
    clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  /** The number of buckets held, across every limit. */
  get size(): number {
    return this.perIp.size + this.perMachine.size + this.tunnelPerIp.size + this.badKeys.size
  }
}

function refused(waitMs: number): Admission {
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) }
}
