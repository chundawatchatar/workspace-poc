import { describe, expect, test } from 'bun:test'
import { createReattacher, REATTACH_DELAY, type ReattachTimer } from './reconnect'

// A clock that only moves when the test advances it.
function fakeTimer() {
  let now = 0
  let nextHandle = 1
  const pending = new Map<number, { at: number; callback: () => void }>()
  const timer: ReattachTimer = {
    set: (callback, ms) => {
      const handle = nextHandle++
      pending.set(handle, { at: now + ms, callback })
      return handle
    },
    clear: (handle) => pending.delete(handle as number),
  }
  const advance = (ms: number) => {
    now += ms
    for (const [handle, entry] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (entry.at > now) continue
      pending.delete(handle)
      entry.callback()
    }
  }
  return { timer, advance, pending }
}

function setup(online: boolean) {
  const sockets: { closed: boolean; close: () => void }[] = []
  const clock = fakeTimer()
  const reattacher = createReattacher({
    online,
    timer: clock.timer,
    open: () => {
      const socket = { closed: false, close: () => (socket.closed = true) }
      sockets.push(socket)
      return socket
    },
  })
  return { sockets, reattacher, ...clock }
}

describe('terminal reattach', () => {
  test('opens nothing while offline, including after a close', () => {
    const offline = setup(false)
    offline.advance(60_000)
    expect(offline.sockets).toHaveLength(0)

    const dropped = setup(true)
    dropped.reattacher.setOnline(false)
    dropped.reattacher.closed(dropped.sockets[0])
    dropped.advance(60_000)
    expect(dropped.sockets).toHaveLength(1)
  })

  test('a close while online reopens once after a second', () => {
    const { sockets, reattacher, advance } = setup(true)
    reattacher.closed(sockets[0])
    advance(REATTACH_DELAY - 1)
    expect(sockets).toHaveLength(1)
    advance(1)
    expect(sockets).toHaveLength(2)
    advance(60_000)
    expect(sockets).toHaveLength(2)
  })

  test('coming online opens at once and cancels a pending retry, but never a second socket', () => {
    const { sockets, reattacher, advance, pending } = setup(true)
    reattacher.setOnline(true)
    expect(sockets).toHaveLength(1)

    reattacher.closed(sockets[0])
    reattacher.setOnline(true)
    expect(sockets).toHaveLength(2)
    expect(pending.size).toBe(0)
    advance(60_000)
    expect(sockets).toHaveLength(2)
  })

  test('disposing cancels the retry and closes the socket', () => {
    const first = setup(true)
    first.reattacher.dispose()
    expect(first.sockets[0].closed).toBe(true)

    const second = setup(true)
    second.reattacher.closed(second.sockets[0])
    second.reattacher.dispose()
    second.advance(60_000)
    expect(second.sockets).toHaveLength(1)
  })
})
