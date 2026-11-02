import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { AGENT_LABELS } from '@orch/shared'
import { z } from 'zod'
import type { AgentHook } from './agent-state'
import { AGENTS, type AgentAdapter, type TrackedAgentKind, trackedKinds } from './agents'

/** The one event a hook of `agents` can report. It has no field that could carry a prompt, a tool or a path. */
export function agentEventFor(agents: readonly AgentAdapter[]) {
  return z.strictObject({
    agent: z.enum(trackedKinds(agents)),
    state: z.enum(['working', 'waiting', 'idle']),
    reason: z.enum(['started', 'prompt', 'tool', 'permission', 'question', 'finished', 'exited']),
  })
}
export const agentEvent = agentEventFor(AGENTS)
export type AgentEvent = z.infer<typeof agentEvent>

const trackingFlags = Object.fromEntries(trackedKinds().map((kind) => [kind, z.boolean()]))

/** Which agents a session may report for. */
export const agentTracking = z.object(trackingFlags as Record<TrackedAgentKind, z.ZodBoolean>)
export type AgentTracking = z.infer<typeof agentTracking>

/** The same answer for every tracked agent. */
export function trackingForAll(on: boolean): AgentTracking {
  return Object.fromEntries(trackedKinds().map((kind) => [kind, on])) as AgentTracking
}

const anyTracked = (tracking: AgentTracking) => Object.values(tracking).some(Boolean)

/** What a shell needs to report for its session. Only that shell's environment ever holds it. */
export interface AgentShellEnv {
  token: string
  socket: string
  /** The folder of the agents' shims and `orch-agent-hook`, put first on `PATH`. Null means it couldn't be written. */
  shimDir: string | null
}

/** The biggest event body accepted. */
const MAX_BODY = 256
const SESSION_BURST = 20
const SESSION_REFILL_PER_SECOND = 10
const SHARED_BURST = 200
const SHARED_REFILL_PER_SECOND = 200
/** How long a fresh `waiting` holds against a `working` / `tool` that may have arrived out of order. */
const WAITING_HOLD_MS = 1000
/** How long after `agentExited` a late event from the ended agent run is ignored. */
const EXIT_DROP_MS = 1000
const LOG_EVERY_MS = 60_000

/** The channel's socket, next to the daemon's `hostSocket`. */
export function agentSocketPath(hostSocket: string): string {
  return join(dirname(hostSocket), 'agent.sock')
}

/** A token bucket that fills up as the clock moves, so nothing has to run while no events arrive. */
class Bucket {
  private tokens: number
  private filled: number

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
    now: number,
  ) {
    this.tokens = burst
    this.filled = now
  }

  /** True when there is room for one more event at `now`. */
  hasRoom(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, now - this.filled) * this.perSecond) / 1000)
    this.filled = now
    return this.tokens >= 1
  }

  take() {
    this.tokens -= 1
  }
}

interface SessionState {
  tracking: AgentTracking
  token: string | null
  hook: AgentHook | null
  bucket: Bucket
  /** The newest event refused by the rate limit, applied once there is room. */
  held: { event: AgentEvent; at: number } | null
  /** When the host last said the agent run ended. */
  exitedAt: number
  /** True once a turn-end-only agent reported `finished` in this agent run, so its next one is a real turn. */
  finishedOnce: boolean
}

function failure(status: number, error: string) {
  return Response.json({ error }, { status })
}

/** The request body, or null once it is over the limit. A missing or wrong `Content-Length` changes nothing. */
async function readBody(request: Request): Promise<Buffer | null> {
  if (Number(request.headers.get('content-length')) > MAX_BODY) return null
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * The daemon's local reporting channel: who may report for which session, and
 * the last thing each session's agent reported. A token is the session's
 * identity, so no request can name a session, and it exists only in the
 * session's shell and here. See "Local reporting channel" in `docs/agents.md`.
 *
 * It is plain logic behind `handle`, because the daemon's `main.ts` runs at
 * import and `daemonBuild` hashes only that one file of the daemon.
 */
export class AgentChannel {
  private readonly sessions = new Map<string, SessionState>()
  private readonly tokens = new Map<string, string>()
  private readonly shared: Bucket
  /** Rate-limited events per session since the last log line. */
  private readonly dropped = new Map<string, number>()
  private loggedAt: number
  /** The bound socket; null until `open`, and no tokens are issued without it. */
  private socket: string | null = null
  private shimDir: string | null = null
  private readonly events: ReturnType<typeof agentEventFor>

  constructor(
    /** Called after a session's hook state changes. */
    private readonly onChange: (id: string) => void,
    /** Called when a hook event is a moment the user should be told about, with a fixed message. */
    private readonly onNotify: (id: string, message: string) => void,
    private readonly log: (message: string) => void = console.warn,
    private readonly now: () => number = Date.now,
    private readonly agents: readonly AgentAdapter[] = AGENTS,
  ) {
    this.events = agentEventFor(agents)
    this.shared = new Bucket(SHARED_BURST, SHARED_REFILL_PER_SECOND, now())
    this.loggedAt = now()
  }

  /** Marks the channel as reachable at `socket`, so shells started from now on get a token and `shimDir`. */
  open(socket: string, shimDir: string | null = null) {
    this.socket = socket
    this.shimDir = shimDir
  }

  /** The session's last hook event, or null when there is none for this agent run. */
  hook(id: string): AgentHook | null {
    return this.sessions.get(id)?.hook ?? null
  }

  /**
   * Sets which agents a session tracks, creating its state on first use. All
   * false forgets the token and the hook state at once. Turning tracking on
   * gives a running shell no token; only its next start does.
   */
  setTracking(id: string, tracking: AgentTracking) {
    const session = this.sessions.get(id)
    if (!session) {
      this.sessions.set(id, {
        tracking,
        token: null,
        hook: null,
        bucket: new Bucket(SESSION_BURST, SESSION_REFILL_PER_SECOND, this.now()),
        held: null,
        exitedAt: Number.NEGATIVE_INFINITY,
        finishedOnce: false,
      })
      return
    }
    // Turning an agent back on starts a new agent run as far as the early `finished` goes.
    if (trackedKinds(this.agents).some((kind) => tracking[kind] && !session.tracking[kind])) {
      session.finishedOnce = false
    }
    session.tracking = tracking
    if (!anyTracked(tracking)) {
      this.forget(id, session)
      return
    }
    if (session.held && !tracking[session.held.event.agent]) session.held = null
    if (session.hook && !tracking[session.hook.agent]) this.clearHook(id, session)
  }

  /** A new token for a shell about to start, replacing any earlier one, or null when it must not get one. */
  issue(id: string): AgentShellEnv | null {
    const session = this.sessions.get(id)
    if (!session) return null
    this.forget(id, session)
    const { socket } = this
    if (!socket || !anyTracked(session.tracking)) return null
    const token = randomBytes(32).toString('hex')
    session.token = token
    this.tokens.set(token, id)
    return { token, socket, shimDir: this.shimDir }
  }

  /** The session's shell ended, so its token stops working and its agent run is over. */
  shellExited(id: string) {
    const session = this.sessions.get(id)
    if (session) this.forget(id, session)
  }

  /** The session closed. */
  close(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.token) this.tokens.delete(session.token)
    this.sessions.delete(id)
  }

  /** The host saw the agent run end. Events that arrive just after it belong to that run, except a new `started`. */
  agentExited(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    session.exitedAt = this.now()
    session.held = null
    this.clearHook(id, session)
  }

  /** Applies held events that now fit the rate limit, and logs the drop counts when one is due. */
  tick() {
    const now = this.now()
    for (const [id, session] of this.sessions) {
      if (!session.held || !this.admit(session, now)) continue
      const { event, at } = session.held
      session.held = null
      this.apply(id, session, event, at)
    }
    if (now - this.loggedAt < LOG_EVERY_MS) return
    this.loggedAt = now
    for (const [id, count] of this.dropped) this.log(`ptyd-bun: agent channel dropped ${count} event(s) for ${id}`)
    this.dropped.clear()
  }

  /** Answers one request from a shell. Every error body is a fixed code, and none repeats the input. */
  async handle(request: Request): Promise<Response> {
    const route = `${request.method} ${new URL(request.url).pathname}`
    if (route !== 'GET /v1/session' && route !== 'POST /v1/state') return failure(404, 'not_found')
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1]
    const caller = this.lookup(token)
    if (!caller) return failure(401, 'unauthorized')
    if (route === 'GET /v1/session') {
      const { tracking } = caller.session
      return Response.json(Object.fromEntries(trackedKinds(this.agents).map((kind) => [kind, tracking[kind]])))
    }
    const body = await readBody(request).catch(() => null)
    if (!body) return failure(413, 'too_large')
    const parsed = this.events.safeParse(parseJson(body))
    // The token may have been forgotten while the body was arriving.
    const owner = this.lookup(token)
    if (!owner) return failure(401, 'unauthorized')
    const { id, session } = owner
    if (!parsed.success || !session.tracking[parsed.data.agent]) return failure(400, 'bad_request')
    return this.accept(id, session, parsed.data)
  }

  private lookup(token: string | undefined) {
    const id = token && this.tokens.get(token)
    const session = id && this.sessions.get(id)
    return id && session ? { id, session } : null
  }

  private accept(id: string, session: SessionState, event: AgentEvent): Response {
    const now = this.now()
    if (!this.admit(session, now)) {
      session.held = { event, at: now }
      this.dropped.set(id, (this.dropped.get(id) ?? 0) + 1)
      return failure(429, 'rate_limited')
    }
    // The held event came first, and the ordering rule between the two still has to see it.
    if (session.held) this.apply(id, session, session.held.event, session.held.at)
    session.held = null
    this.apply(id, session, event, now)
    return new Response(null, { status: 204 })
  }

  /** Counts one event against both limits, or against neither when either is full. */
  private admit(session: SessionState, now: number): boolean {
    if (!session.bucket.hasRoom(now) || !this.shared.hasRoom(now)) return false
    session.bucket.take()
    this.shared.take()
    return true
  }

  private apply(id: string, session: SessionState, event: AgentEvent, at: number) {
    const { agent, state, reason } = event
    if (reason !== 'started' && at - session.exitedAt < EXIT_DROP_MS) return
    if (reason === 'exited') {
      this.clearHook(id, session)
      return
    }
    const { hook } = session
    const late = hook?.state === 'waiting' && state === 'working' && reason === 'tool'
    if (late && at - hook.at < WAITING_HOLD_MS) return
    session.hook = { agent, state, reason, at }
    this.onChange(id)
    const message = this.notification(session, hook?.agent === agent ? hook : null, event)
    if (message) this.onNotify(id, message)
  }

  /**
   * The message for an event that is a moment the user should be told about,
   * or null. `previous` is the hook state before it, from the same agent. See
   * "Notifications (AG-3)" in `docs/agents.md`.
   */
  private notification(session: SessionState, previous: AgentHook | null, event: AgentEvent): string | null {
    const { agent, state, reason } = event
    const label = AGENT_LABELS[agent]
    if (this.agents.find((adapter) => adapter.kind === agent)?.tracking?.turnEndOnly) {
      if (state !== 'idle' || reason !== 'finished') return null
      // The first report of a run is the title turn's, which can come while the real turn still runs.
      const first = !session.finishedOnce
      session.finishedOnce = true
      return first ? null : `${label} finished`
    }
    if (previous?.state === state && previous.reason === reason) return null
    const fromTurn = previous !== null && previous.state !== 'idle'
    if (state === 'idle' && reason === 'finished') return fromTurn ? `${label} finished` : null
    if (state === 'waiting' && reason === 'permission') return `${label} needs permission`
    // A question that follows `idle` is the agent's reminder that it is still waiting, not a new moment.
    const asking = previous?.state === 'working' || previous?.reason === 'permission'
    if (state === 'waiting' && reason === 'question' && asking) return `${label} has a question`
    return null
  }

  private forget(id: string, session: SessionState) {
    if (session.token) this.tokens.delete(session.token)
    session.token = null
    session.held = null
    this.clearHook(id, session)
  }

  private clearHook(id: string, session: SessionState) {
    session.finishedOnce = false
    if (!session.hook) return
    session.hook = null
    this.onChange(id)
  }
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString())
  } catch {
    return undefined
  }
}
