import { AGENT_LABELS, type SessionInfo, type TermServerMsg } from '@orch/shared'
import { DAEMON_PROTOCOL, type TermClient } from '@orch/terminal'

/** Gives the screen to the views that are behind; redrawing the others would flicker and lose their scroll position. */
export function sendSnapshot(clients: Iterable<TermClient>, data: string, size: { cols: number; rows: number }) {
  const snapshot: Extract<TermServerMsg, { type: 'snapshot' }> = {
    type: 'snapshot',
    data,
    cols: size.cols,
    rows: size.rows,
  }
  for (const client of clients) {
    if (client.ready && !client.stale) continue
    client.queue = []
    client.queued = 0
    const serverQueries = !client.answers
    if (client.buffered() > 1024 * 1024 || client.send(JSON.stringify({ ...snapshot, serverQueries })) === 0) {
      client.stale = true
      client.ready = false
      continue
    }
    client.ready = true
    client.stale = false
  }
}

/** Shows a view the notice of a terminal whose agent the daemon lost. The overlay in the web app offers the choices. */
export function sendInterrupted(
  client: TermClient,
  interrupted: NonNullable<SessionInfo['interrupted']>,
  size: { cols: number; rows: number },
) {
  const label = AGENT_LABELS[interrupted.agent.kind]
  const text =
    `\x1b[2m[The terminal daemon restarted while ${label} was running in ${interrupted.cwd}.\r\n` +
    ` Resume ${label}, or press Enter for a plain shell.]\x1b[0m\r\n`
  client.send(JSON.stringify({ type: 'snapshot', data: text, ...size } satisfies TermServerMsg))
  client.queue = []
  client.queued = 0
  client.stale = false
  client.ready = true
}

/** Shows a view a line of text in place of the terminal's screen, while it has none to show. */
export function sendNotice(client: TermClient, text: string) {
  client.send(JSON.stringify({ type: 'snapshot', cols: 80, rows: 24, data: text } satisfies TermServerMsg))
}

/** What a terminal shows while the daemon can't be reached. */
export function unavailableNotice(error: unknown): string {
  return `\r\nTerminal daemon unavailable: ${error instanceof Error ? error.message : String(error)}\r\n`
}

/** What a terminal shows while the daemon speaks another protocol. Replacing the daemon is the user's choice. */
export function refusalNotice(protocol: number, stopHint: string): string {
  return (
    `\r\nThe running terminal daemon speaks protocol ${protocol}, while this host speaks ${DAEMON_PROTOCOL}, so this ` +
    'terminal cannot attach to it. Its shells are still running.\r\n' +
    `The one way to replace it is to stop this host and run \`${stopHint}\`, which ends those shells.\r\n`
  )
}
