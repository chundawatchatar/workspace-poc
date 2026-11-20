import type { AgentReport } from '@orch/agents/runtime'

/** A report in the standard status, with when the daemon read it. */
export interface AgentReportAt extends AgentReport {
  at: number
}

/** A session's status goes out at most this often; changes in between go out together, with the latest state. */
export const STATUS_INTERVAL_MS = 100
/** The same notification is raised at most this often per session, however often its moment comes back. */
export const NOTIFY_REPEAT_MS = 2000

interface SessionReports {
  report: AgentReportAt | null
  /** The session's switch (AG-5). Off, reports are still kept, so the state is right when it is on again. */
  reporting: boolean
  /** When its status last went out, and the send waiting for the interval to pass, if any. */
  changedAt: number
  pending: ReturnType<typeof setTimeout> | null
  /** When each message was last raised. */
  notified: Map<string, number>
}

/**
 * The message for a change that is a moment the user should be told about, or
 * null. Messages are fixed words, never text from the report; the tab beside
 * them says which agent it is.
 */
function notification(previous: AgentReport | null, next: AgentReport): string | null {
  if (previous?.state === next.state && previous.reason === next.reason) return null
  if (next.state === 'waiting') {
    if (next.reason === 'permission') return 'Needs permission'
    if (next.reason === 'auth') return 'Needs you to sign in'
    return 'Has a question'
  }
  const fromTurn = previous !== null && previous.state !== 'idle'
  if (next.state === 'idle' && fromTurn && next.reason === 'finished') return 'Finished'
  if (next.state === 'idle' && fromTurn && next.reason === 'error') return 'Failed'
  return null
}

/**
 * Each session's last report in the standard status, read from its own output
 * by `readProgramStatus`, and the notifications a change raises. It lives in the
 * daemon, which sees every byte a session prints and owns its attention, so
 * both survive a host restart. A program that changes its status in a loop
 * sends at most one status per `STATUS_INTERVAL_MS` and the same notification at
 * most once per `NOTIFY_REPEAT_MS`, so it can't flood the views or the user. See
 * "Agent status" in `docs/agents.md`.
 */
export class AgentReports {
  private readonly sessions = new Map<string, SessionReports>()

  constructor(
    /** Called after a session's report changes. */
    private readonly onChange: (id: string) => void,
    /** Called when a change is a moment the user should be told about, with a fixed message. */
    private readonly onNotify: (id: string, message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** The session's last report, or null when its program has none. */
  last(id: string): AgentReportAt | null {
    return this.sessions.get(id)?.report ?? null
  }

  /** Sets the session's switch, creating its state on first use. */
  setReporting(id: string, on: boolean) {
    const session = this.sessions.get(id)
    if (session) session.reporting = on
    else
      this.sessions.set(id, { report: null, reporting: on, changedAt: -Infinity, pending: null, notified: new Map() })
  }

  /** Takes in a report the session's program wrote. Repeating the last one changes nothing. */
  report(id: string, report: AgentReport | 'clear') {
    const session = this.sessions.get(id)
    if (!session) return
    if (report === 'clear') return this.clear(id)
    const previous = session.report
    if (previous?.state === report.state && previous.reason === report.reason) return
    const now = this.now()
    session.report = { ...report, at: now }
    this.changed(id, session)
    // Every change is judged, so a quick turn still says it finished; only a message repeating too soon is dropped.
    const message = session.reporting && notification(previous, report)
    if (!message || now - (session.notified.get(message) ?? -Infinity) < NOTIFY_REPEAT_MS) return
    session.notified.set(message, now)
    this.onNotify(id, message)
  }

  /** The agent or the shell ended, so its report goes. */
  clear(id: string) {
    const session = this.sessions.get(id)
    if (!session?.report) return
    session.report = null
    this.changed(id, session)
  }

  close(id: string) {
    const session = this.sessions.get(id)
    if (session?.pending) clearTimeout(session.pending)
    this.sessions.delete(id)
  }

  /** Sends the session's status now, or once the interval has passed; a send already waiting carries this change too. */
  private changed(id: string, session: SessionReports) {
    if (session.pending) return
    const wait = session.changedAt + STATUS_INTERVAL_MS - this.now()
    const send = () => {
      session.pending = null
      session.changedAt = this.now()
      this.onChange(id)
    }
    if (wait <= 0) return send()
    session.pending = setTimeout(send, wait)
    session.pending.unref?.()
  }
}
