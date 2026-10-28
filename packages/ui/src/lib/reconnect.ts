/** The timer a reattacher schedules retries with. Tests pass a fake one. */
export interface ReattachTimer {
  set: (callback: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimer: ReattachTimer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** The wait before a terminal socket that closed while online is opened again, in milliseconds. */
export const REATTACH_DELAY = 1000

export interface Reattacher {
  /** Says whether the page is connected. Turning online opens a socket at once if none is open or opening. */
  setOnline: (online: boolean) => void
  /** Reports that `socket` closed. Only the current socket counts; a retry follows while online. */
  closed: (socket: unknown) => void
  /** Cancels any retry and closes the socket. */
  dispose: () => void
}

/**
 * Decides when a terminal's socket opens: at once while `online`, again
 * `REATTACH_DELAY` after it closes while still online, and never while offline.
 * `open` creates the socket and wires its handlers, which call `closed`.
 */
export function createReattacher<S extends { close: () => void }>(options: {
  open: () => S
  online: boolean
  timer?: ReattachTimer
}): Reattacher {
  const { open, timer = realTimer } = options
  let online = options.online
  let socket: S | null = null
  let retry: unknown
  let disposed = false

  const cancelRetry = () => {
    timer.clear(retry)
    retry = undefined
  }

  const connect = () => {
    cancelRetry()
    if (disposed || !online || socket) return
    socket = open()
  }

  connect()

  return {
    setOnline(next) {
      online = next
      // Going offline drops a pending retry; coming back reattaches without waiting for it.
      if (online) connect()
      else cancelRetry()
    },
    closed(closedSocket) {
      if (closedSocket !== socket) return
      socket = null
      if (disposed || !online) return
      cancelRetry()
      retry = timer.set(connect, REATTACH_DELAY)
    },
    dispose() {
      disposed = true
      cancelRetry()
      const current = socket
      socket = null
      current?.close()
    },
  }
}
