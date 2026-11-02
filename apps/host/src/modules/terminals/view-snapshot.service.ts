import { AGENT_LABELS, type SessionInfo, type TermServerMsg } from '@orch/shared'
import type { TermClient } from '@orch/terminal'

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
