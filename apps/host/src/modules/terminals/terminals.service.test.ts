import { describe, expect, test } from 'bun:test'
import { deliver, parseProgress, shellEnv, type TermClient } from './terminals.service'

/** A client whose socket reports `backlog` unsent bytes, recording what it was sent. */
function setup({ ready = true, backlog = 0, result = 1 } = {}) {
  const sent: (string | Uint8Array)[] = []
  const client: TermClient = {
    ready,
    queue: [],
    queued: 0,
    stale: false,
    want: null,
    send: (data) => {
      sent.push(data)
      return result
    },
    buffered: () => backlog,
  }
  return { client, sent }
}

const chunk = (bytes: number) => new Uint8Array(bytes)

describe('deliver', () => {
  test('a client that falls behind is marked stale and skips output until resynced', () => {
    const healthy = setup()
    deliver(healthy.client, chunk(10))
    expect(healthy.sent).toHaveLength(1)
    expect(healthy.client.stale).toBe(false)

    const lagging = setup({ backlog: 2 * 1024 * 1024 })
    deliver(lagging.client, chunk(10))
    deliver(lagging.client, chunk(10))
    expect(lagging.sent).toHaveLength(0)
    expect(lagging.client.stale).toBe(true)

    const dropped = setup({ result: 0 })
    deliver(dropped.client, chunk(10))
    expect(dropped.client.stale).toBe(true)
  })

  test('output queued before the snapshot is capped, and an overflow marks the client stale', () => {
    const { client, sent } = setup({ ready: false })
    deliver(client, chunk(1000))
    expect(client.queue).toHaveLength(1)

    deliver(client, chunk(2 * 1024 * 1024))
    expect(client).toMatchObject({ queue: [], queued: 0, stale: true })
    expect(sent).toHaveLength(0)
  })
})

describe('shellEnv', () => {
  test('keeps identity and locale, drops what launched the host, and cleans PATH', () => {
    const env = shellEnv({
      HOME: '/Users/me',
      LC_ALL: 'en_US.UTF-8',
      CLAUDECODE: '1',
      npm_lifecycle_event: 'dev',
      GITHUB_TOKEN: 'secret',
      PATH: '/repo/node_modules/.bin:/tmp/bun-node-abc:/opt/homebrew/bin:/usr/bin',
    })
    expect(env).toEqual({
      HOME: '/Users/me',
      LC_ALL: 'en_US.UTF-8',
      PATH: '/opt/homebrew/bin:/usr/bin',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'workspace-poc',
    })
  })
})

test('parseProgress turns OSC 9;4 into a spinner state and leaves other OSC 9 payloads as notifications', () => {
  expect(parseProgress('4;3;')).toBe('busy')
  expect(parseProgress('4;1;45')).toBe('busy')
  expect(parseProgress('4;2;100')).toBe('error')
  expect(parseProgress('4;0;')).toBeNull()
  expect(parseProgress('Build finished')).toBeUndefined()
})
