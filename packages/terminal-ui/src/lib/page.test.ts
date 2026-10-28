import { afterEach, describe, expect, test } from 'bun:test'
import { makeWorkspace, type ServerEvent, type Workspace } from '@orch/shared'
import type { HostTransport } from '../transport'
import { pageView } from './page'
import { connect, getSnapshot, getTransport } from './store'

/** A transport whose events socket the test drives by hand. */
function fakeHost() {
  const socket = { close: () => {} } as unknown as WebSocket
  const transport: HostTransport = {
    request: async () => Response.json({}),
    openSocket: () => socket,
  }
  const send = (event: ServerEvent) => socket.onmessage?.({ data: JSON.stringify(event) } as MessageEvent)
  return { transport, send }
}

function hello(workspaces: Workspace[]): ServerEvent {
  const info = { home: '/home/me', shell: 'zsh', platform: 'darwin', projectRoot: '/tmp' }
  return { type: 'hello', clientId: 'c1', state: { rev: 1, workspaces }, sessions: [], info }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('pageView', () => {
  test('waits for the store to be connected to its own transport before redirecting', () => {
    const a = fakeHost()
    const b = fakeHost()
    const other = makeWorkspace('Other', '/tmp')
    const x = makeWorkspace('X', '/tmp')

    const disconnectA = connect(a.transport)
    cleanups.push(disconnectA)
    a.send(hello([other]))
    // The layout from A lacks X, but the page is for B, so it must not redirect home yet.
    expect(pageView(getSnapshot(), a.transport, x.id)).toBe('redirect')
    expect(pageView(getSnapshot(), b.transport, x.id)).toBe('connecting')

    cleanups.push(connect(b.transport))
    expect(pageView(getSnapshot(), b.transport, x.id)).toBe('connecting')
    // A's cleanup runs after B connected, as React may order it, and leaves B in place.
    disconnectA()
    expect(getTransport()).toBe(b.transport)
    expect(getSnapshot().transport).toBe(b.transport)
    // A late message from A's socket must not stand in for B's layout.
    a.send(hello([other]))
    expect(pageView(getSnapshot(), b.transport, x.id)).toBe('connecting')

    b.send(hello([other, x]))
    expect(pageView(getSnapshot(), b.transport, x.id)).toBe('workspace')
    expect(pageView(getSnapshot(), b.transport, 'gone')).toBe('redirect')
  })
})
