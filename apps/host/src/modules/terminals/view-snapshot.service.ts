import type { TermServerMsg } from '@orch/shared'
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
