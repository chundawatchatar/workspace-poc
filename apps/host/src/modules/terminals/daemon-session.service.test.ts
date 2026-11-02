import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRef } from '@orch/shared'
import { type AgentTracking, DAEMON_PROTOCOL, DaemonDecoder, encodeControlFrame } from '@orch/terminal'
import { AgentTrackingRepository } from '../agent-tracking/agent-tracking.repository'
import { AgentTrackingService } from '../agent-tracking/agent-tracking.service'
import type { DaemonRecord, DaemonRepository } from './daemon.repository'
import { resendTracking } from './daemon.service'
import { DaemonSession } from './daemon-session.service'
import type { SharedDaemon } from './shared-daemon.service'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const status = {
  protocol: DAEMON_PROTOCOL,
  id: 't1',
  instance: 'a'.repeat(32),
  daemonPid: 10,
  pid: 11,
  alive: true,
  title: 'zsh',
  attention: null,
  progress: null,
  cols: 80,
  rows: 24,
}
const agent: AgentRef = { kind: 'claude', sessionId: null, cwd: '/repo' }
const found = (pid: number) => ({
  busy: true,
  cwd: '/repo',
  process: { pid, name: 'claude', command: 'claude', elapsed: 1 },
})

async function until(check: () => boolean) {
  for (let tries = 0; tries < 200 && !check(); tries++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

/**
 * A session attached to a fake daemon, which records every message and sends the statuses the test gives it.
 * Its record lives in `records`, so a second session with the same id reads what the first saved.
 */
async function setup(tracking: () => AgentTracking, records = new Map<string, DaemonRecord>()) {
  const dir = mkdtempSync('/tmp/orch-session-')
  const received: { type: string; tracking?: unknown }[] = []
  let peer: Socket | undefined
  const server: Server = createServer((socket) => {
    peer = socket
    const decoder = new DaemonDecoder()
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind !== 'control') continue
        received.push(frame.value as (typeof received)[number])
        if (received.length === 1) socket.write(encodeControlFrame({ type: 'snapshot', data: '', status }))
      }
    })
  })
  const path = join(dir, 'host.sock')
  await new Promise<void>((done) => server.listen(path, done))
  const get = (id: string) => records.get(id) ?? { id, token: crypto.randomUUID() }
  const repository = {
    socket: path,
    get,
    update: (id: string, patch: Partial<DaemonRecord>) => {
      const next = JSON.parse(JSON.stringify({ ...get(id), ...patch })) as DaemonRecord
      records.set(id, next)
      return next
    },
  } as unknown as DaemonRepository
  const shared = { repository, tracking, heard() {}, ensureStarted: async () => {} } as unknown as SharedDaemon
  let changes = 0
  const session = new DaemonSession('t1', '/repo', 80, 24, () => changes++, shared)
  cleanups.push(() => {
    session.shutdown()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  await until(() => session.pid === 11)
  const report = (patch: object) => peer?.write(encodeControlFrame({ type: 'status', status: { ...status, ...patch } }))
  return { session, received, report, changes: () => changes, records }
}

/** Trust answers kept in a temporary folder, with no file to start with. */
function answers() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-trust-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return new AgentTrackingService(new AgentTrackingRepository(join(dir, 'agent-tracking.json')))
}

const trackingSent = (received: { type: string }[]) =>
  received.filter((message) => message.type === 'tracking').map(({ type: _type, ...tracking }) => tracking)

test('the trust answers decide what hello and tracking carry, and a changed answer reaches every open session', async () => {
  const trust = answers()
  const first = await setup(() => trust.tracking())
  expect(first.received[0]).toMatchObject({ type: 'hello', tracking: { claude: false, codex: false } })

  const second = await setup(() => trust.tracking())
  trust.onChange(() => resendTracking([first.session, second.session]))
  trust.update({ agent: 'claude', answer: 'on' })
  for (const { received } of [first, second]) {
    await until(() => trackingSent(received).length === 1)
    expect(trackingSent(received)).toEqual([{ claude: true, codex: false }])
  }
  trust.update({ agent: 'claude', answer: 'on' })
  await Bun.sleep(10)
  expect(trackingSent(first.received)).toHaveLength(1)

  const third = await setup(() => trust.tracking())
  expect(third.received[0]).toMatchObject({ type: 'hello', tracking: { claude: true, codex: false } })
})

test('the per-session switch drops the agent state at once, is saved, and survives a host restart', async () => {
  const { session, received, report, records } = await setup(() => ({ claude: true, codex: true }))
  session.observe(found(100) as never)
  session.observeAgent(agent, false)
  report({ agentHook: { agent: 'claude', state: 'working', reason: 'tool', at: Date.now() } })
  await until(() => session.info().agentState?.source === 'hooks')
  expect(session.info().agentTracking).toBe(true)

  session.setAgentTracking(false)
  expect(session.info()).toMatchObject({ agentTracking: false, agentState: null })
  expect(records.get('t1')?.agentTracking).toBe(false)
  await until(() => trackingSent(received).length === 1)
  expect(trackingSent(received)).toEqual([{ claude: false, codex: false }])

  // The host restarts: a new session reads the record and tells the daemon tracking is off.
  const restarted = await setup(() => ({ claude: true, codex: true }), records)
  expect(restarted.received[0]).toMatchObject({ type: 'hello', tracking: { claude: false, codex: false } })
  expect(restarted.session.info().agentTracking).toBe(false)

  session.setAgentTracking(true)
  expect(records.get('t1')).not.toHaveProperty('agentTracking')
  expect(session.info()).toMatchObject({ agentTracking: true, agentState: { source: 'hooks' } })
  await until(() => trackingSent(received).length === 2)
  expect(trackingSent(received)[1]).toEqual({ claude: true, codex: true })
})

test('the daemon hears agentExited when a known agent leaves or its process changes, and only then', async () => {
  const { session, received } = await setup(() => ({ claude: false, codex: false }))
  const exits = () => received.filter((message) => message.type === 'agentExited').length
  session.observeAgent(null, false)
  session.observe(found(100) as never)
  session.observeAgent(agent, false)
  session.observeAgent(agent, false)
  await Bun.sleep(10)
  expect(exits()).toBe(0)

  session.observe(found(200) as never)
  session.observeAgent(agent, false)
  await until(() => exits() === 1)

  session.observe({ busy: false, cwd: '/repo' } as never)
  session.observeAgent(null, false)
  await until(() => exits() === 2)
  session.observeAgent(null, false)
  await Bun.sleep(10)
  expect(exits()).toBe(2)
})

test('a working hook turns interrupted once progress has ended and the wait is over, until the next hook event', async () => {
  const { session, report, changes } = await setup(() => ({ claude: true, codex: true }))
  session.observe(found(100) as never)
  session.observeAgent(agent, false)
  const agentHook = { agent: 'claude', state: 'working', reason: 'tool', at: Date.now() - 10 }
  report({ agentHook, progress: 'busy' })
  await until(() => session.info().progress === 'busy')
  expect(session.info().agentState).toMatchObject({ reason: 'tool', source: 'hooks' })
  expect(Object.keys(session.info())).not.toContain('agentHook')
  const before = Date.now
  try {
    report({ agentHook, progress: null })
    await until(() => session.info().progress === null)
    expect(session.info().agentState).toMatchObject({ state: 'working', source: 'hooks' })
    const seen = changes()
    const later = before() + 3100
    Date.now = () => later
    expect(session.info().agentState).toMatchObject({ state: 'idle', reason: 'interrupted', source: 'signals' })
    Date.now = before
    report({ agentHook: { ...agentHook, at: later }, progress: null })
    await until(() => changes() > seen)
    Date.now = () => later + 1
    expect(session.info().agentState).toMatchObject({ state: 'working', reason: 'tool', source: 'hooks' })
  } finally {
    Date.now = before
  }
})
