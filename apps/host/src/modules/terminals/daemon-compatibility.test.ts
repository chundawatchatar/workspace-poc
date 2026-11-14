import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { daemonResponse, routes } from '@orch/shared'
import { DAEMON_PROTOCOL, DaemonDecoder, encodeControlFrame, encodeOutputFrame, type TermClient } from '@orch/terminal'
import { type AppDeps, createApp } from '../../app'
import { localRequest } from '../../app.testing'
import { daemonFactory } from './daemon.service'
import { daemonCompatibility, stopDaemonHint } from './daemon-build'

const cleanups: (() => void)[] = []
afterEach(() => {
  mock.restore()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('daemonCompatibility', () => {
  test('a matching build is current, another or a missing one outdated, a refusal incompatible', () => {
    expect(daemonCompatibility({ type: 'status', build: 'abc' }, 'abc')).toBe('current')
    expect(daemonCompatibility({ type: 'status', build: 'old' }, 'abc')).toBe('outdated')
    expect(daemonCompatibility({ type: 'status', build: undefined }, 'abc')).toBe('outdated')
    expect(daemonCompatibility({ type: 'refused', protocol: 2 }, 'abc')).toBe('incompatible')
    expect(daemonCompatibility(null, 'abc')).toBeNull()
  })
})

async function until(check: () => boolean, what: string) {
  for (let tries = 0; tries < 400 && !check(); tries++) await Bun.sleep(10)
  if (!check()) throw new Error(`timed out waiting for ${what}`)
}

/** Every record file's bytes, by name. */
function recordFiles(dataDir: string) {
  const dir = join(dataDir, 'terminal-daemons')
  return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]))
}

/** A view that keeps every message the session sends it. */
function view() {
  const sent: string[] = []
  const client: TermClient = {
    send: (data) => {
      sent.push(typeof data === 'string' ? data : Buffer.from(data).toString())
      return 1
    },
    buffered: () => 0,
    ready: false,
    queue: [],
    queued: 0,
    stale: false,
    want: null,
    answers: false,
  }
  return { client, sent }
}

const status = {
  protocol: DAEMON_PROTOCOL,
  id: 't1',
  instance: 'b'.repeat(32),
  daemonPid: 10,
  pid: 11,
  alive: true,
  title: 'zsh',
  attention: null,
  progress: null,
  cols: 80,
  rows: 24,
  build: 'another-build',
}

/**
 * A fake daemon on the runtime socket. While `refusing` it answers every hello with `refused` and closes, as a daemon
 * of the next protocol does; after that it attaches with a status of another build and echoes input as output.
 */
async function fakeDaemon(socketPath: string) {
  const state = { refusing: true, received: [] as { type: string }[] }
  const server: Server = createServer((socket) => {
    const decoder = new DaemonDecoder()
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind !== 'control') continue
        const message = frame.value as { type: string; data?: string }
        state.received.push(message)
        if (message.type === 'hello' && state.refusing) {
          socket.end(encodeControlFrame({ type: 'refused', protocol: DAEMON_PROTOCOL + 1 }))
        } else if (message.type === 'hello') {
          socket.write(encodeControlFrame({ type: 'snapshot', data: 'restored screen', status }))
        } else if (message.type === 'input') {
          socket.write(encodeOutputFrame(Buffer.from(`echo:${message.data}`)))
        }
      }
    })
  })
  await new Promise<void>((done) => server.listen(socketPath, done))
  cleanups.push(() => server.close())
  return state
}

test('a host leaves a daemon of another protocol and its records alone, then attaches to one of its own', async () => {
  const dir = mkdtempSync('/tmp/orch-compat-')
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const dataDir = join(dir, 'data')
  const spawned = join(dir, 'spawned')
  const factory = daemonFactory({
    dataDir,
    runtime: join(dir, 'run'),
    daemonCommand: ['/bin/sh', '-c', `touch ${spawned}`, 'sh'],
    build: 'this-build',
    stopHint: stopDaemonHint(false),
  })
  factory.repository.update('t1', { agent: { kind: 'claude', sessionId: null, cwd: '/repo' } })
  factory.repository.get('orphan')
  const records = recordFiles(dataDir)
  const daemon = await fakeDaemon(factory.repository.socket)
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const error = spyOn(console, 'error').mockImplementation(() => {})
  spyOn(console, 'log').mockImplementation(() => {})

  // Before anything was heard, and again once the refusal is known.
  await factory.reconcile(new Set(['t1']))
  const { client, sent } = view()
  const session = factory.create('t1', '/repo', 80, 24, () => {})
  cleanups.push(() => session.shutdown())
  session.attach(client)
  await factory.reconcile(new Set(['t1']))
  // The terminal retries every second: wait for two retries.
  await until(() => daemon.received.filter((message) => message.type === 'hello').length >= 4, 'the retries')

  expect(existsSync(spawned)).toBe(false)
  expect(daemon.received.map((message) => message.type)).toEqual(daemon.received.map(() => 'hello'))
  expect(recordFiles(dataDir)).toEqual(records)
  expect(session.info().interrupted).toBeNull()
  expect(sent.at(-1)).toContain(`speaks protocol ${DAEMON_PROTOCOL + 1}`)
  expect(sent.at(-1)).toContain('bun run terminals:stop')
  const app = createApp({
    sessions: { list: () => [session] },
    daemon: () => factory.shared.report(),
  } as unknown as AppDeps).app
  const report = async () => daemonResponse.parse(await (await localRequest(app, routes.system.daemon.path)).json())
  expect(await report()).toMatchObject({
    compatibility: 'incompatible',
    daemonProtocol: DAEMON_PROTOCOL + 1,
    stopCommand: 'bun run terminals:stop',
  })
  expect(warn.mock.calls.filter(([line]) => String(line).includes('protocol'))).toHaveLength(1)
  expect(error).not.toHaveBeenCalled()

  // A daemon of this host's protocol but another build: the terminal attaches and works, reported as out of date.
  daemon.refusing = false
  await until(() => sent.some((message) => message.includes('restored screen')), 'the snapshot')
  session.input('ls', client)
  await until(() => sent.includes('echo:ls'), 'the echoed input')
  expect(await report()).toMatchObject({ compatibility: 'outdated', daemonProtocol: DAEMON_PROTOCOL })
  expect(warn.mock.calls.at(-1)?.[0]).toContain('bun run terminals:stop')
}, 15_000)
