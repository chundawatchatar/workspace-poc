import { agentKind, detectAgent } from './agents'
import type { TerminalSession } from './core'
import { inspectShells } from './processes'

/** Creates the session for a tab. The host passes the daemon's factory. */
export type SessionFactory = (
  id: string,
  cwd: string,
  cols: number,
  rows: number,
  onChange: (session: TerminalSession) => void,
) => TerminalSession

/** The terminal of every open tab, inspected for what it runs and closed with its tab. */
export class SessionManager {
  private readonly sessions = new Map<string, TerminalSession>()

  constructor(
    private readonly onChange: (session: TerminalSession) => void,
    private readonly onGone: (id: string) => void,
    private readonly create: SessionFactory,
  ) {}

  get(id: string) {
    return this.sessions.get(id)
  }

  list() {
    return [...this.sessions.values()]
  }

  /** Terminates a terminal when its tab is explicitly removed from the layout. */
  close(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    session.kill()
    this.sessions.delete(id)
    this.onGone(id)
  }

  ensure(id: string, cwd: string, cols: number, rows: number): TerminalSession {
    let session = this.sessions.get(id)
    if (!session) {
      session = this.create(id, cwd, cols, rows, this.onChange)
      this.sessions.set(id, session)
      this.onChange(session)
    }
    return session
  }

  /** Whether a session is still within the grace period in which a missing tab may just be a layout lagging behind. */
  isNew(id: string): boolean {
    const session = this.sessions.get(id)
    return session !== undefined && Date.now() - session.createdAt < SessionManager.GRACE
  }

  /**
   * Ends sessions whose tab no longer exists. New ones get a grace period to appear in the layout. Returns
   * whether any was spared for that reason, so the caller can collect again once the grace period is over.
   */
  collect(liveIds: Set<string>): boolean {
    let spared = false
    for (const id of this.sessions.keys()) {
      if (liveIds.has(id)) continue
      if (this.isNew(id)) spared = true
      else this.close(id)
    }
    return spared
  }

  static readonly GRACE = 10_000

  /** Refreshes what every live shell is running. Sessions report a change through `onChange`. */
  async inspect() {
    const live = this.list().filter((session) => session.pid !== undefined)
    if (live.length === 0) return
    const found = await inspectShells(live.map((session) => session.pid as number))
    const seen = live.flatMap((session) => {
      if (session.pid === undefined) return []
      const shell = found.get(session.pid)
      session.observe(shell)
      // A shell not found may have died with the daemon, so the agent it ran stays on record to be resumed.
      if (!shell) return []
      const { process, cwd } = session.info()
      return [{ session, process, cwd, key: process && `${agentKind(process)}:${cwd}` }]
    })
    const count = new Map<string, number>()
    for (const { key } of seen) if (key) count.set(key, (count.get(key) ?? 0) + 1)
    for (const { session, process, cwd, key } of seen) {
      const ambiguous = key ? (count.get(key) ?? 0) > 1 : false
      session.observeAgent(process ? detectAgent(process, cwd, undefined, !ambiguous) : null, ambiguous)
    }
  }

  /** Disconnects from the daemon when the host stops. The terminals keep running there. */
  shutdown() {
    for (const session of this.sessions.values()) session.shutdown()
    this.sessions.clear()
  }
}
