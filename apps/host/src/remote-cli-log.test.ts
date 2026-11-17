import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatLocalDateTime, type RemoteAccessStatus } from '@orch/shared'
import { AuditLogRepository, auditLogPath } from './modules/remote-access/audit-log.repository'
import { AuditLogService } from './modules/remote-access/audit-log.service'
import { fingerprintOf } from './modules/remote-access/device-proof.service'
import { createRemoteAccessRoutes, type RemoteAccessDeps } from './modules/remote-access/remote-access.routes'
import { createHostCaller, runRemote } from './remote-cli'

const MINUTE = 60_000
const START = Date.UTC(2026, 10, 6, 12)
const deviceId = (seed: number) => Buffer.from(new Uint8Array(32).fill(seed)).toString('base64url')
const [alice, bob, carol] = [1, 2, 3].map((seed) => ({
  id: deviceId(seed),
  fingerprint: fingerprintOf(deviceId(seed)),
}))

const status: RemoteAccessStatus = {
  serverUrl: 'wss://relay.example.com',
  serverUrlIsDefault: false,
  defaultServerUrl: 'wss://orch.example.com',
  serverUrlSetBy: null,
  machineId: 'm1',
  machineFingerprint: 'ABCD-EFGH-JKMN-PQRS',
  tunnel: 'connected',
  linkedAccount: null,
  connectRequest: null,
  connectOutcome: null,
}

let dir: string
let server: ReturnType<typeof Bun.serve> | null
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-remote-cli-log-'))
  server = null
})
afterEach(() => {
  server?.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

/** Serves the real remote access routes over an audit log kept apart from the CLI's data folder, and answers its base URL. */
function runningHost(audit: AuditLogService): string {
  // Only `status` and `auditLog` are reached by `log`.
  const remoteAccess = { status: () => status, auditLog: () => ({ entries: audit.recent() }) }
  const routes = createRemoteAccessRoutes({ remoteAccess } as unknown as RemoteAccessDeps)
  server = Bun.serve({ port: 0, fetch: routes.fetch })
  return `http://127.0.0.1:${server.port}`
}

/** A base URL nothing listens on: a server is started to get a free port, then stopped. */
function stoppedHost(): string {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const url = `http://127.0.0.1:${probe.port}`
  probe.stop(true)
  return url
}

async function log(baseUrl: string, args = ['log']) {
  const lines: string[] = []
  const code = await runRemote(args, {
    callHost: createHostCaller(baseUrl),
    dataDir: dir,
    env: {},
    prompt: async () => null,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    now: () => START,
  })
  return { code, text: lines.join('\n') }
}

/** An audit log at `file` whose clock starts at `START`, with a closed session, an open one and two refusals. */
function recordActivity(file: string) {
  let clock = START
  const audit = new AuditLogService(new AuditLogRepository(file), () => clock)
  audit.record({
    kind: 'opened',
    session: 's1',
    principal: { kind: 'account', accountId: 'acct-1', deviceId: alice?.id ?? '', ticketExp: 0 },
  })
  clock += MINUTE
  audit.record({ kind: 'closed', session: 's1' })
  audit.record({
    kind: 'opened',
    session: 's2',
    principal: { kind: 'account', accountId: 'acct-1', deviceId: bob?.id ?? '', ticketExp: 0 },
  })
  clock += MINUTE
  audit.record({
    kind: 'refused',
    reason: 'device_not_approved',
    device: { id: carol?.id ?? '', principal: 'account' },
  })
  audit.record({ kind: 'refused', reason: 'ticket_refused' })
  return audit
}

const at = (minutes: number) => formatLocalDateTime(START + minutes * MINUTE)
const expected = [
  `${at(2)}  refused  ticket_refused`,
  `${at(2)}  refused  device_not_approved  ${carol?.fingerprint}`,
  `${at(1)}  opened   account  ${bob?.fingerprint}  still open or not recorded`,
  `${at(0)}  opened   account  ${alice?.fingerprint}  closed ${at(1)}`,
].join('\n')

describe('host:remote log', () => {
  test('prints the newest entries from the running host, or from the file with the host stopped', async () => {
    const throughHost = await log(runningHost(recordActivity(join(dir, 'host-audit.jsonl'))))
    expect(throughHost).toEqual({ code: 0, text: expected })
    for (const hidden of ['acct-1', alice?.id, bob?.id, carol?.id]) expect(throughHost.text).not.toContain(hidden)

    recordActivity(auditLogPath(dir))
    expect(await log(stoppedHost())).toEqual({ code: 0, text: expected })
  })

  test('is listed in the usage, which a stray word prints', async () => {
    const { code, text } = await log(stoppedHost(), ['log', 'more'])
    expect(code).toBe(1)
    expect(text).toContain('\n  log  ')
  })

  test('says nothing was recorded for a missing or empty file, running or stopped', async () => {
    const none = { code: 0, text: 'No remote access recorded' }
    expect(await log(stoppedHost())).toEqual(none)
    writeFileSync(auditLogPath(dir), '')
    expect(await log(stoppedHost())).toEqual(none)
    expect(await log(runningHost(new AuditLogService(new AuditLogRepository(auditLogPath(dir)))))).toEqual(none)
  })
})
