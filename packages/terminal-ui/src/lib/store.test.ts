import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  CLOSE_ACCESS_DENIED,
  CLOSE_DEVICE_NOT_APPROVED,
  CLOSE_MACHINE_OFFLINE,
  type ClientEvent,
  makeWorkspace,
  type ServerEvent,
  type SessionInfo,
} from '@orch/shared'
import { MODE_KEY, themeKey } from '@orch/ui'
import type { HostTransport } from '../transport'
import {
  ackSession,
  type ConnectTimer,
  connect,
  dispatch,
  getSnapshot,
  initTheme,
  mutate,
  pushState,
  reconnect,
  restoreSession,
  type Snapshot,
  selectTheme,
  setAgentTracking,
  setThemeChoice,
} from './store'

/** A transport whose events sockets the test opens, messages and closes. */
function fakeTransport() {
  const sockets: WebSocket[] = []
  const sent: ClientEvent[] = []
  const transport: HostTransport = {
    request: async () => Response.json({}),
    openSocket: () => {
      const socket = {
        readyState: 1,
        send: (data: string) => sent.push(JSON.parse(data)),
        close: () => {},
      } as unknown as WebSocket
      sockets.push(socket)
      return socket
    },
  }
  const last = () => sockets[sockets.length - 1]
  return {
    transport,
    sockets,
    sent,
    emit: (event: ServerEvent) => last().onmessage?.({ data: JSON.stringify(event) } as MessageEvent),
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

  test('a browser waiting for approval keeps retrying with the backoff, and opens once approved', () => {
    const fake = fakeTransport()
    const { timer, advance, delays } = fakeTimer()
    disconnect = connect(fake.transport, timer)

    fake.close(CLOSE_DEVICE_NOT_APPROVED)
    expect(getSnapshot().status).toBe('unapproved')
    advance(1000)
    fake.close(CLOSE_DEVICE_NOT_APPROVED)
    advance(2000)
    fake.close(CLOSE_DEVICE_NOT_APPROVED)
    expect(delays).toEqual([1000, 2000, 4000])
    expect(getSnapshot().status).toBe('unapproved')

    advance(4000)
    fake.hello('approved')
    expect(getSnapshot().status).toBe('open')
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

describe('host updates and local edits', () => {
  test('receives session changes and removal, and sends terminal actions over the connection', () => {
    const fake = fakeTransport()
    disconnect = connect(fake.transport, fakeTimer().timer)
    fake.hello()
    const session: SessionInfo = {
      id: 't1',
      title: 'Terminal',
      alive: true,
      attention: null,
      process: null,
      cwd: '/tmp',
      progress: null,
      agent: null,
      interrupted: null,
      agentState: null,
      agentTracking: true,
    }
    fake.emit({ type: 'session', session })
    expect(getSnapshot().sessions.t1).toEqual(session)
    fake.emit({ type: 'session', session: { ...session, title: 'Changed', alive: false } })
    expect(getSnapshot().sessions.t1).toMatchObject({ title: 'Changed', alive: false })
    ackSession('t1')
    restoreSession('t1', 'agent')
    restoreSession('t1', 'shell')
    setAgentTracking('t1', false)
    expect(fake.sent).toEqual([
      { type: 'ack', sessionId: 't1' },
      { type: 'restore', sessionId: 't1', mode: 'agent' },
      { type: 'restore', sessionId: 't1', mode: 'shell' },
      { type: 'agentTracking', sessionId: 't1', on: false },
    ])
    fake.emit({ type: 'session.gone', id: 't1' })
    expect(getSnapshot().sessions).toEqual({})
    const remote = { rev: 20, workspaces: [makeWorkspace('remote', '/remote')] }
    fake.emit({ type: 'state', state: remote })
    expect(getSnapshot().state).toEqual(remote)
  })

  test('ignores edits before hello and no-op changes, and defers drag synchronization until pushState', () => {
    const fake = fakeTransport()
    disconnect = connect(fake.transport, fakeTimer().timer)
    mutate(() => {
      throw new Error('No layout yet')
    })
    dispatch({ type: 'workspace.rename', workspaceId: 'missing', name: 'ignored' })
    pushState()
    expect(fake.sent).toEqual([])
    fake.hello()
    const original = getSnapshot()
    mutate((state) => state)
    dispatch({ type: 'workspace.rename', workspaceId: 'missing', name: 'ignored' })
    expect(getSnapshot()).toBe(original)
    const id = original.state?.workspaces[0].id
    if (!id) throw new Error('Expected a workspace')
    dispatch({ type: 'workspace.rename', workspaceId: id, name: 'dragging' }, false)
    expect(getSnapshot().state?.workspaces[0].name).toBe('dragging')
    expect(fake.sent).toEqual([])
    pushState()
    const pushed = getSnapshot().state
    if (!pushed) throw new Error('Expected a layout')
    expect(fake.sent).toEqual([{ type: 'state', state: pushed }])
    mutate((state) => ({ ...state, rev: state.rev + 1 }), false)
    expect(fake.sent).toHaveLength(1)
    mutate((state) => ({ ...state, rev: state.rev + 1 }))
    expect(fake.sent).toHaveLength(2)
    const updated = getSnapshot().state
    if (!updated) throw new Error('Expected a layout')
    expect(fake.sent[1]).toEqual({ type: 'state', state: updated })
  })
})

describe('theme preferences', () => {
  let stop = () => {}
  afterEach(() => {
    stop()
    mock.restore()
    localStorage.clear()
    // Puts the store back on the default theme for the tests after this one.
    initTheme()()
  })

  test('restores saved themes, follows system changes only in system mode, and saves a selected theme', () => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    let light = false
    Object.defineProperty(media, 'matches', { configurable: true, get: () => light })
    spyOn(window, 'matchMedia').mockReturnValue(media)
    localStorage.setItem(MODE_KEY, 'invalid')
    localStorage.setItem(themeKey('dark'), 'dracula')
    localStorage.setItem(themeKey('light'), 'invalid')
    stop = initTheme()
    expect(getSnapshot()).toMatchObject({ themeChoice: 'system', theme: 'dark', themeId: 'dracula' })
    light = true
    media.dispatchEvent(new Event('change'))
    expect(getSnapshot()).toMatchObject({ themeChoice: 'system', theme: 'light', themeId: 'daylight' })
    selectTheme('solarized-light')
    expect(getSnapshot()).toMatchObject({ themeChoice: 'system', themeId: 'solarized-light' })
    expect(localStorage.getItem(themeKey('light'))).toBe('solarized-light')
    selectTheme('nord')
    expect(getSnapshot()).toMatchObject({ themeChoice: 'dark', themeId: 'nord' })
    expect(localStorage.getItem(MODE_KEY)).toBe('dark')
    media.dispatchEvent(new Event('change'))
    expect(getSnapshot().theme).toBe('dark')
    const selected = getSnapshot()
    selectTheme('unknown')
    expect(getSnapshot()).toBe(selected)
    setThemeChoice('system')
    expect(getSnapshot().theme).toBe('light')
    stop()
    light = false
    media.dispatchEvent(new Event('change'))
    expect(getSnapshot().theme).toBe('light')
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
