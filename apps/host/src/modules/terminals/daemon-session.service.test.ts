import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { AgentRef } from '@orch/shared'
import { DAEMON_PROTOCOL, DaemonDecoder, encodeControlFrame } from '@orch/terminal'
import type { DaemonRecord, DaemonRepository } from './daemon.repository'
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
  agentReport: null,
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
async function setup(records = new Map<string, DaemonRecord>()) {
  const dir = mkdtempSync('/tmp/orch-session-')
  const received: { type: string; reporting?: unknown; on?: unknown }[] = []
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
  const shared = { repository, heard() {}, ensureStarted: async () => {} } as unknown as SharedDaemon
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

const reportingSent = (received: { type: string; on?: unknown }[]) =>
  received.filter((message) => message.type === 'reporting').map((message) => message.on)

test('the per-session switch drops the agent state at once, is saved, tells the daemon, and survives a host restart', async () => {
  const { session, received, report, records } = await setup()
  expect(received[0]).toMatchObject({ type: 'hello', reporting: true })
  session.observe(found(100) as never)
  session.observeAgent(agent, false)
  report({ agentReport: { state: 'working', reason: 'turn', at: Date.now() } })
  await until(() => session.info().agentState?.state === 'working')
  expect(session.info().agentTracking).toBe(true)

  session.setAgentTracking(false)
  expect(session.info()).toMatchObject({ agentTracking: false, agentState: null })
  expect(records.get('t1')?.agentTracking).toBe(false)
  await until(() => reportingSent(received).length === 1)
  expect(reportingSent(received)).toEqual([false])

  // The host restarts: a new session reads the record and tells the daemon the switch is off.
  const restarted = await setup(records)
  expect(restarted.received[0]).toMatchObject({ type: 'hello', reporting: false })
  expect(restarted.session.info().agentTracking).toBe(false)

  session.setAgentTracking(true)
  expect(records.get('t1')).not.toHaveProperty('agentTracking')
  expect(session.info()).toMatchObject({ agentTracking: true, agentState: { state: 'working', reason: 'turn' } })
  await until(() => reportingSent(received).length === 2)
  expect(reportingSent(received)[1]).toBe(true)
})

test('the daemon hears agentExited when a known agent leaves or its process changes, and only then', async () => {
  const { session, received } = await setup()
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
