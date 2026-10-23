import { describe, expect, test } from 'bun:test'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import {
  assignResponder,
  deliver,
  modesTail,
  parseProgress,
  scrollRegion,
  scrollRegionTail,
  shellEnv,
  shellProgram,
  type TermClient,
  TerminalCore,
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
    answers: false,
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
test('scrollRegionTail keeps a wrap pending at the right margin', async () => {
  const original = screen()
  original.term.write('123456789012')
  await settle(original.term)

  const restored = screen()
  restored.term.write(original.serializer.serialize() + scrollRegionTail(original.term, null))
  restored.term.write('X')
  await settle(restored.term)
  expect(rows(restored.term).split('\n').slice(0, 2)).toEqual(['123456789012', 'X'])
})

test('scrollRegionTail puts the cursor back after origin mode homes it', async () => {
  const original = screen()
  original.term.write('\x1b[?6h\x1b[3;1H123456789012')
  await settle(original.term)

  const restored = screen()
  restored.term.write(original.serializer.serialize() + scrollRegionTail(original.term, null))
  await settle(restored.term)
  expect(restored.term.buffer.active.cursorY).toBe(2)
})

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

test('assignResponder lets exactly one view answer queries, preferring the controller', () => {
  const a = setup()
  const b = setup()
  const clients = new Set([a.client, b.client])
  expect(assignResponder(clients, b.client)).toBe(true)
  expect([a.client.answers, b.client.answers]).toEqual([false, true])
  expect(b.sent).toEqual([JSON.stringify({ type: 'queries', answer: true })])
  expect(a.sent).toEqual([])

  clients.delete(b.client)
  assignResponder(clients, b.client)
  expect(a.client.answers).toBe(true)
  expect(assignResponder(new Set(), null)).toBe(false)
})

/** A real shell on a PTY, as a daemon session runs it. */
async function shell() {
  const core = new TerminalCore(
    'test',
    process.cwd(),
    80,
    24,
    () => {},
    () => {},
    '/bin/bash',
  )
  const waitFor = async (text: string) => {
    for (let tries = 0; tries < 100; tries++) {
      const screen = await core.snapshot()
      if (screen.includes(text)) return screen
      await Bun.sleep(50)
    }
    throw new Error(`timed out waiting for ${text} in ${JSON.stringify(await core.snapshot())}`)
  }
  // Prompt themes and rc files differ between machines; a bare prompt keeps the screen predictable.
  core.input("PS1='$ '; clear; echo RE''ADY\r")
  await waitFor('READY')
  return { core, waitFor }
}

/** The modes a program sets that change what the terminal sends back to it, read from a restored terminal. */
function inputModes(term: Terminal) {
  const core = (term as unknown as { _core: Record<string, Record<string, unknown>> })._core
  const decModes = (core.coreService as { decPrivateModes: Record<string, unknown> }).decPrivateModes
  return {
    buffer: term.buffer.active.type,
    ...term.modes,
    encoding: core.coreMouseService.activeEncoding,
    cursorHidden: core.coreService.isCursorHidden,
    cursorStyle: decModes.cursorStyle,
    cursorBlink: decModes.cursorBlink,
  }
}

/**
 * Codex and pi enable SGR mouse reporting on the alternate screen; a snapshot
 * that dropped the encoding made their scrolling stop after a reconnect.
 */
test('a snapshot restores every input mode a full-screen program sets', async () => {
  const { core, waitFor } = await shell()
  core.input(
    "printf '\\033[?1049h\\033[?1h\\033=\\033[?2004h\\033[?1004h\\033[?1003h\\033[?1016h\\033[?25l\\033[4 q%s' MA''RK\r",
  )
  const snapshot = await waitFor('MARK')
  core.kill()

  const restored = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  await new Promise<void>((done) => restored.write(snapshot, done))
  expect(inputModes(restored)).toMatchObject({
    buffer: 'alternate',
    applicationCursorKeysMode: true,
    applicationKeypadMode: true,
    bracketedPasteMode: true,
    sendFocusMode: true,
    mouseTrackingMode: 'any',
    encoding: 'SGR_PIXELS',
    cursorHidden: true,
    cursorStyle: 'underline',
    cursorBlink: false,
  })
}, 15_000)

test('a session answers terminal queries only while no view answers them', async () => {
  const { core, waitFor } = await shell()
  core.setPalette({ background: '#102030' })
  // Reads the reply to a query; with nobody answering, `read` gives up after a second and `r` stays empty.
  const ask = (query: string, end: string, mark: string) =>
    core.input(`r=; printf '${query}'; IFS= read -rs -t 1 -d '${end}' r; echo "${mark}<\${r//[^a-z0-9:;?\\/]/}>"\r`)

  core.answerQueries(true)
  ask('\\033[c', 'c', 'DA')
  // The typed command line holds `DA<$`, so only the reply itself matches.
  await waitFor('DA<?1;2>')
  ask('\\033]11;?\\033\\\\', '\\', 'BG')
  await waitFor('BG<11;rgb:1010/2020/3030>')

  core.answerQueries(false)
  ask('\\033[c', 'c', 'NONE')
  // `read` times out with nothing, so the line prints empty brackets; any reply would have filled them.
  await waitFor('NONE<>')
  core.kill()
}, 15_000)
