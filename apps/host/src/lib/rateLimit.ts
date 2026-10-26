/** Frames a connection may send at once before the rate applies. */
export const RATE_BURST = 500
/** Frames per second a connection may send in the long run. */
export const RATE_PER_SECOND = 200
/** Dropped frames within `FLOOD_WINDOW_MS` that get a connection closed. */
export const FLOOD_DROPS = 1000
/** The sliding window, in milliseconds, over which dropped frames are counted. */
export const FLOOD_WINDOW_MS = 10_000

/** What to do with an incoming frame. */
export type RateDecision = 'accept' | 'drop' | 'close'

/** Limits and clock for one limiter. Any field left out takes the exported default. */
export interface RateLimitOptions {
  burst?: number
  perSecond?: number
  floodDrops?: number
  floodWindowMs?: number
  /** Milliseconds since some fixed point. Tests pass a fake clock. */
  now?: () => number
}

/**
 * Creates the limiter for one connection: a token bucket plus a count of
 * recent drops. Call it once per incoming frame. A single spike over the
 * rate only loses frames; `'close'` comes only after `floodDrops` drops
 * within `floodWindowMs`, and only once, so the caller warns once.
 */
export function createRateLimiter({
  burst = RATE_BURST,
  perSecond = RATE_PER_SECOND,
  floodDrops = FLOOD_DROPS,
  floodWindowMs = FLOOD_WINDOW_MS,
  now = () => performance.now(),
}: RateLimitOptions = {}): () => RateDecision {
  let tokens = burst
  let refilledAt = now()
  // The times of the last `floodDrops` drops, as a ring. The slot about to be
  // overwritten holds the oldest, so the window check is constant time.
  const drops: number[] = []
  let next = 0
  let closed = false

  return () => {
    const t = now()
    tokens = Math.min(burst, tokens + ((t - refilledAt) / 1000) * perSecond)
    refilledAt = t
    if (tokens >= 1) {
      tokens -= 1
      return 'accept'
    }
    if (closed) return 'drop'
    drops[next] = t
    next = (next + 1) % floodDrops
    // Once the ring is full, `drops[next]` is the oldest of the last `floodDrops` drops.
    if (drops.length === floodDrops && t - (drops[next] ?? 0) < floodWindowMs) {
      closed = true
      return 'close'
    }
    return 'drop'
  }
}
