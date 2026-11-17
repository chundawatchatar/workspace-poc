import type { MachineConnection } from '../tunnel/tunnel.service'

/** A machine's `enroll.request`, held until the owner answers it, its tunnel closes or its key expires. */
export interface WaitingRequest {
  /** The request id: the id of the enrollment key's row. */
  id: string
  /** The tunnel the request came over, where the final answer goes. */
  conn: MachineConnection
  /** The `id` of the `enroll.request` frame, which the final answer carries. */
  frameId: number
  /** The id the tunnel proved, the only machine the request may link. */
  machineId: string
  /** When the key, and so the request, expires. */
  expiresAt: Date
}

/**
 * The connect requests waiting for their owner's answer, by request id. A
 * request is live only while it is here and unexpired, so a row left behind by
 * a restart, a closed tunnel or an expired key is never listed or accepted.
 * Each tunnel holds at most one, which bounds the memory. It lives in memory
 * only, like the `MachineRegistry`, so it is only right with one server
 * instance.
 */
export class ConnectRequests {
  private readonly byId = new Map<string, WaitingRequest>()
  private readonly byConn = new Map<MachineConnection, string>()
  /** Tunnels already closed, so an answer that lands after the close can't hold a request for one. */
  private readonly closed = new WeakSet<MachineConnection>()

  /**
   * Holds `request`, replacing the request its tunnel held before and any
   * earlier holder of the same id. False when its tunnel has already closed,
   * which holds nothing.
   */
  hold(request: WaitingRequest): boolean {
    if (this.closed.has(request.conn)) return false
    const earlier = this.byConn.get(request.conn)
    if (earlier !== undefined) this.byId.delete(earlier)
    const previous = this.byId.get(request.id)
    if (previous) this.byConn.delete(previous.conn)
    this.byId.set(request.id, request)
    this.byConn.set(request.conn, request.id)
    return true
  }

  /**
   * The request with `id` while it waits at `now`. Undefined once it ended or
   * expired. It changes nothing: an expired request goes with its tunnel, or
   * when the tunnel asks again.
   */
  waiting(id: string, now: Date): WaitingRequest | undefined {
    const request = this.byId.get(id)
    return request && request.expiresAt.getTime() > now.getTime() ? request : undefined
  }

  /** Ends `request`, once answered, unless another request has taken its place. */
  end(request: WaitingRequest): void {
    if (this.byId.get(request.id) !== request) return
    this.byId.delete(request.id)
    this.byConn.delete(request.conn)
  }

  /** Ends the request `conn` holds, for its tunnel closing, and refuses any it would hold later. */
  connectionClosed(conn: MachineConnection): void {
    this.closed.add(conn)
    const id = this.byConn.get(conn)
    const request = id === undefined ? undefined : this.byId.get(id)
    if (request) this.end(request)
  }
}
