import type { ServerEvent } from '@orch/shared'

export interface EventClient {
  id: string
  send(event: ServerEvent): void
}

/** The clients connected to the events socket, and fan-out to them. */
export class EventHub {
  private readonly clients = new Set<EventClient>()

  add(client: EventClient) {
    this.clients.add(client)
  }

  remove(client: EventClient) {
    this.clients.delete(client)
  }

  /** Sends to every client, optionally skipping the one the change came from. */
  broadcast(event: ServerEvent, except?: EventClient) {
    for (const client of this.clients) if (client !== except) client.send(event)
  }
}
