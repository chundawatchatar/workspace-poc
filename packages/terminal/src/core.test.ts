import { describe, expect, test } from 'bun:test'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import {
  deliver,
  modesTail,
  parseProgress,
  scrollRegion,
  scrollRegionTail,
  shellEnv,
  shellProgram,
  type TermClient,
} from './core'

test('shellProgram uses a platform fallback only when the user has not selected a shell', () => {
  expect(shellProgram({}, 'linux')).toBe('/bin/sh')
  expect(shellProgram({}, 'darwin')).toBe('/bin/zsh')
  expect(shellProgram({ SHELL: '/custom/fish' }, 'linux')).toBe('/custom/fish')
})

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

/** A headless terminal that mirrors what the daemon keeps for a session. */
function screen() {
  const term = new Terminal({ cols: 12, rows: 5, scrollback: 100, allowProposedApi: true })
  const serializer = new SerializeAddon()
  term.loadAddon(serializer)
  return { term, serializer }
}
const settle = (term: Terminal) => new Promise<void>((done) => term.write('', () => done()))
function rows(term: Terminal): string {
  const buffer = term.buffer.active
  return Array.from({ length: term.rows }, (_, i) =>
    (buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '').trimEnd(),
  ).join('\n')
}

test('scrollRegion reads DECSTBM bounds and ignores a sequence xterm would', () => {
  expect(scrollRegion([2, 4], 24)).toEqual({ top: 1, bottom: 3 })
  expect(scrollRegion([0], 24)).toEqual({ top: 0, bottom: 23 })
  expect(scrollRegion([2, 0], 24)).toEqual({ top: 1, bottom: 23 })
  expect(scrollRegion([2, 2], 24)).toBeNull()
})

test('modesTail restores the mouse encoding and alternate scroll the serializer drops', () => {
  const modes = new Map([
    [1006, true],
    [1007, true],
    [1005, false],
  ])
  expect(modesTail(modes)).toBe('\x1b[?1006h\x1b[?1007h\x1b[?1005l')
})

/**
 * A full-screen program paints a status line outside a scrolling region and then
 * scrolls inside it. xterm's serialize addon drops the region, so without the
 * tail a restored terminal scrolls the whole screen instead.
 */
test('scrollRegionTail keeps a scrolling region a serialized snapshot drops', async () => {
  const original = screen()
  original.term.write('\x1b[1;1HTOP\x1b[5;1HBOT\x1b[2;4r\x1b[4;1Hone\r\ntwo\r\nthree\r\nfour\r\nfive')
  await settle(original.term)

  const restored = screen()
  restored.term.write(original.serializer.serialize() + scrollRegionTail(original.term, { top: 1, bottom: 3 }))
  await settle(restored.term)

  original.term.write('\r\nsix')
  restored.term.write('\r\nsix')
  await settle(original.term)
  await settle(restored.term)

  expect(rows(restored.term)).toBe(rows(original.term))
  expect(rows(restored.term).split('\n')[0]).toBe('TOP')
  expect(rows(restored.term).split('\n')[4]).toBe('BOT')
})
