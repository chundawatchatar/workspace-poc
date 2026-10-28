import { afterEach, describe, expect, test } from 'bun:test'
import { CLOSE_ACCESS_DENIED, CLOSE_MACHINE_OFFLINE, makeWorkspace, type ServerEvent } from '@orch/shared'
import type { HostTransport } from '../transport'
import { type ConnectTimer, connect, getSnapshot, reconnect, type Snapshot } from './store'

/** A transport whose events sockets the test opens, messages and closes. */
function fakeTransport() {
  const sockets: WebSocket[] = []
  const transport: HostTransport = {
    request: async () => Response.json({}),
    openSocket: () => {
      const socket = { close: () => {} } as unknown as WebSocket
      sockets.push(socket)
      return socket
    },
  }
  const last = () => sockets[sockets.length - 1]
  return {
    transport,
    sockets,
    open: () => last().onopen?.({} as Event),
    hello: (name = 'main') => {
      const event: ServerEvent = {
        type: 'hello',
        clientId: 'c1',
        state: { rev: 1, workspaces: [makeWorkspace(name, '/tmp')] },
        sessions: [],
        info: { home: '/home', shell: 'zsh', platform: 'darwin', projectRoot: '/tmp' },
      }
      last().onmessage?.({ data: JSON.stringify(event) } as MessageEvent)
    },
    close: (code: number) => last().onclose?.({ code } as CloseEvent),
  }
}

// A clock that only moves when the test advances it; it records each wait it is asked for.
function fakeTimer() {
  let now = 0
  let nextHandle = 1
  const pending = new Map<number, { at: number; callback: () => void }>()
  const delays: number[] = []
  const timer: ConnectTimer = {
    set: (callback, ms) => {
      delays.push(ms)
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
  return { timer, advance, delays }
}

let disconnect = () => {}
afterEach(() => disconnect())

/** Records every status the store passes through. */
function watchStatus() {
  const seen: Snapshot['status'][] = []
  let stop = false
  const poll = () => {
    if (stop) return
    const status = getSnapshot().status
    if (seen[seen.length - 1] !== status) seen.push(status)
  }
  return { seen, poll, stop: () => (stop = true) }
}

describe('connection status', () => {
  test('is connecting until the first hello, not the socket opening', () => {
    const fake = fakeTransport()
    const { timer } = fakeTimer()
    disconnect = connect(fake.transport, timer)
    fake.open()
    expect(getSnapshot().status).toBe('connecting')
    fake.hello()
    expect(getSnapshot().status).toBe('open')
  })

  test('close codes give offline, denied or reconnecting, and the last layout stays meanwhile', () => {
    const fake = fakeTransport()
    const { timer, advance } = fakeTimer()
    disconnect = connect(fake.transport, timer)

    fake.close(1006)
    expect(getSnapshot().status).toBe('reconnecting')

    advance(1000)
    fake.hello('kept')
    const layout = getSnapshot().state
    fake.close(1006)
    expect(getSnapshot().status).toBe('reconnecting')
    expect(getSnapshot().state).toBe(layout)

    advance(1000)
    fake.close(CLOSE_MACHINE_OFFLINE)
    expect(getSnapshot().status).toBe('offline')
    expect(getSnapshot().state).toBe(layout)

    advance(2000)
    fake.close(CLOSE_ACCESS_DENIED)
    expect(getSnapshot().status).toBe('denied')
  })

  test('a socket that opens and is closed as offline before any hello never shows open', () => {
    const fake = fakeTransport()
    const { timer } = fakeTimer()
    const watch = watchStatus()
    disconnect = connect(fake.transport, timer)
    watch.poll()
    fake.open()
    watch.poll()
    fake.close(CLOSE_MACHINE_OFFLINE)
    watch.poll()
    watch.stop()
    expect(watch.seen).toEqual(['connecting', 'offline'])
  })
})

describe('reconnecting', () => {
  test('backs off 1, 2, 4, 8 then 10 seconds, and a hello resets the wait', () => {
    const fake = fakeTransport()
    const { timer, advance, delays } = fakeTimer()
    disconnect = connect(fake.transport, timer)
    for (let i = 0; i < 6; i++) {
      fake.close(i % 2 ? CLOSE_MACHINE_OFFLINE : 1006)
      advance(delays[delays.length - 1])
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000])
    expect(fake.sockets).toHaveLength(7)

    fake.hello()
    fake.close(1006)
    expect(delays[delays.length - 1]).toBe(1000)
  })

  test('stops after a rejected key until reconnect is called, which opens at once', () => {
    const fake = fakeTransport()
    const { timer, advance } = fakeTimer()
    disconnect = connect(fake.transport, timer)
    fake.hello()
    fake.close(CLOSE_ACCESS_DENIED)
    advance(60 * 60 * 1000)
    expect(fake.sockets).toHaveLength(1)

    reconnect()
    expect(fake.sockets).toHaveLength(2)
    expect(getSnapshot().status).toBe('connecting')
  })

  test('a cleanup after a newer connect keeps the newer transport and schedules nothing', () => {
    const first = fakeTransport()
    const second = fakeTransport()
    const { timer, advance, delays } = fakeTimer()
    const stopFirst = connect(first.transport, timer)
    disconnect = connect(second.transport, timer)
    stopFirst()
    first.close(1006)
    advance(60_000)
    expect(getSnapshot().transport).toBe(second.transport)
    expect(first.sockets).toHaveLength(1)
    expect(delays).toEqual([])
  })
})
