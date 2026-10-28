import { describe, expect, test } from 'bun:test'
import { buildSocketUrl, routes } from '@orch/shared'
import type { SocketConn } from './socket'
import { createSocketRouter, isRefusal, socketEntry } from './socketRouter'

const conn: SocketConn = { send: () => 0, buffered: () => 0, close: () => {} }

function setup() {
  const opened: { socket: string; input: unknown }[] = []
  const session = { message: () => {}, close: () => {} }
  const router = createSocketRouter([
    socketEntry(routes.sockets.events, (input) => {
      opened.push({ socket: 'events', input })
      return session
    }),
    socketEntry(routes.sockets.terminal, (input) => {
      opened.push({ socket: 'terminal', input })
      return session
    }),
  ])
  return { router, opened, session }
}

describe('createSocketRouter', () => {
  test('opens the terminal and events sockets with their parsed input', () => {
    const { router, opened, session } = setup()
    const terminal = buildSocketUrl(routes.sockets.terminal, { id: 'a b/c', cwd: '/tmp/x y', cols: 120, rows: 40 })
    expect(router.open(terminal, [['origin', 'http://localhost:3210']], conn)).toBe(session)
    expect(router.open(`${routes.sockets.events.path}?x=1`, [], conn)).toBe(session)
    // Query fields are read as Hono reads them: `+` is a space, and the first of a repeated name wins.
    router.open('/ws/term/t1?cwd=/a+b&cols=10&cols=99', [], conn)
    expect(opened).toEqual([
      { socket: 'terminal', input: { id: 'a b/c', cwd: '/tmp/x y', cols: 120, rows: 40 } },
      { socket: 'events', input: {} },
      { socket: 'terminal', input: { id: 't1', cwd: '/a b', cols: 10, rows: 24 } },
    ])
  })

  test('refuses with 1008, without running a handler, anything that is not exactly a registered socket', () => {
    const { router, opened } = setup()
    for (const path of [
      '/ws/unknown',
      '/ws/..%2Fapi/system/info',
      '/ws/%2e%2e/api/x',
      '/ws/term/../../api/health',
      '/ws/events/extra',
      '/ws/events/',
      '/ws/term/',
      '/ws/term/%E0%A4%A',
      '/ws//events',
      '/ws/term/t1?cols=0',
    ]) {
      const result = router.open(path, [], conn)
      expect(isRefusal(result) && result.code).toBe(1008)
    }
    const foreign = router.open(routes.sockets.events.path, [['Origin', 'https://evil.example']], conn)
    expect(isRefusal(foreign) && foreign.code).toBe(1008)
    expect(opened).toEqual([])
  })
})
