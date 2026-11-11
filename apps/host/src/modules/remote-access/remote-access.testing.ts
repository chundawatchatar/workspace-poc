import { afterEach, beforeEach, type Mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Endpoint, TunnelState } from '@orch/shared'
import { type AppDeps, createApp } from '../../app'
import type { Principal } from '../../lib/principal'
import { AccessKeyRepository } from '../access/access.repository'
import type { EnrollAnswer, EnrollRequest, TunnelClientOptions } from '../tunnel/tunnel.service'
import type { OpenChannel } from '../tunnel/tunnel-channels.service'
import { AuditLogRepository } from './audit-log.repository'
import { AuditLogService } from './audit-log.service'
import { DevicesRepository } from './devices.repository'
import { LinkedAccountRepository } from './linked-account.repository'
import { testRelayKey } from './relay-ticket.testing'
import { RemoteAccessRepository, type RemoteAccessSettings } from './remote-access.repository'
import { type RemoteAccessEnv, RemoteAccessService } from './remote-access.service'

// Test-only harness for the remote access service: a temp dir, a fake tunnel
// and the service wired to them. Each test file calls
// `useRemoteAccessHarness()` once. Never imported by production code.

/** Stands in for `TunnelClient`, recording what the service asks of it. */
export class FakeTunnel {
  status: TunnelState = 'off'
  /** Every `closeChannels` call: which principals it matches, the reason and the close code, if one was given. */
  closed: { revoked: (principal: Principal) => boolean; reason: string; code?: number }[] = []
  constructor(readonly options: TunnelClientOptions) {}
  start() {
    this.status = 'connecting'
  }
  /** The options of every `stop` call, in order: `{ remoteOff: true }` or undefined. */
  stops: ({ remoteOff: true } | undefined)[] = []
  stop(options?: { remoteOff: true }) {
    this.stops.push(options)
    this.status = 'off'
  }
  /** The open, authorized channels it reports. `closeChannels` drops the ones it matches. */
  channels: OpenChannel[] = []
  closeChannels(revoked: (principal: Principal) => boolean, reason: string, code?: number) {
    this.closed.push({ revoked, reason, ...(code === undefined ? {} : { code }) })
    this.channels = this.channels.filter((channel) => !revoked(channel.principal))
  }
  listChannels() {
    return this.channels
  }
  /** Every enrollment frame sent, in order. */
  sent: EnrollRequest[] = []
  /** How the fake server answers; a throw stands for a timeout or a lost tunnel. */
  answer: (request: EnrollRequest) => EnrollAnswer = () => {
    throw new Error('the server did not answer')
  }
  async enroll(request: EnrollRequest) {
    this.sent.push(request)
    return this.answer(request)
  }
}

/** A base for fakes of the service that have no remote sessions; `remote-cli-sessions.test.ts` covers the command. */
export class NoRemoteSessions {
  listSessions = () => ({ sessions: [] })
  endSession = () => ({ sessions: [] })
}

export const key = `oek_${'k'.repeat(43)}`
export const account = { name: 'Ada', maskedEmail: 'a***@example.com' }
/** The key owner's user id, as the server sends it in `enroll.redeemed`. */
export const accountId = 'acct-ada-1'
/** The server's relay signing key, whose public half it sends in `enroll.redeemed`. */
export const relay = testRelayKey('k1')
export const relayKeys = [relay.relayKey]
export const expiresAt = '2026-11-04T12:15:00.000Z'

export let dir: string
export let tunnels: FakeTunnel[]
export let logs: string[]
let spies: Mock<(...args: unknown[]) => void>[]
export let service: RemoteAccessService

export const settingsFile = () => join(dir, 'remote-access.json')
export const keysFile = () => join(dir, 'access-keys.json')
export const machineKeyFile = () => join(dir, 'machine-key')
export const linkedFile = () => join(dir, 'linked-account.json')
export const devicesFile = () => join(dir, 'devices.json')

/** Gives each test a temp dir and quiet console, and shuts the service down after. */
export function useRemoteAccessHarness() {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orch-remote-'))
    tunnels = []
    logs = []
    spies = (['log', 'error', 'warn'] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.join(' '))),
    )
  })

  afterEach(() => {
    service?.shutdown()
    for (const spy of spies) spy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })
}

/** Starts a service on the temp dir, with `saved` written first and `env` as the environment. */
export function setup(saved?: RemoteAccessSettings | string, env: RemoteAccessEnv = {}) {
  if (saved !== undefined) writeFileSync(settingsFile(), typeof saved === 'string' ? saved : JSON.stringify(saved))
  service = new RemoteAccessService({
    repository: new RemoteAccessRepository(settingsFile()),
    linkedAccounts: new LinkedAccountRepository(linkedFile()),
    devices: new DevicesRepository(devicesFile()),
    audit: new AuditLogService(new AuditLogRepository(join(dir, 'remote-audit.jsonl'))),
    machineKeyFile: machineKeyFile(),
    keysFile: keysFile(),
    env,
    handle: async () => new Response('ok'),
    openSocket: () => ({ code: 1008, reason: 'none' }),
    createTunnel: (options) => {
      const tunnel = new FakeTunnel(options)
      tunnels.push(tunnel)
      return tunnel
    },
  })
  service.start()
  const { app } = createApp({ access: () => service.current(), remoteAccess: service } as unknown as AppDeps)
  return app
}

export const storedKeys = () => new AccessKeyRepository(keysFile()).load()

/** Posts `body` to `endpoint` as a local caller and reads the answer. */
export async function post(app: ReturnType<typeof setup>, endpoint: Endpoint, body: unknown) {
  const response = await app.request(endpoint.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text, json: () => JSON.parse(text) }
}

/** A service on a saved loopback address whose fake tunnel is connected. */
export function connected() {
  const app = setup({ enabled: true, serverUrl: 'ws://127.0.0.1:4600', clientUrl: null })
  const tunnel = tunnels[0]
  if (!tunnel) throw new Error('no tunnel')
  tunnel.status = 'connected'
  return { app, tunnel }
}
