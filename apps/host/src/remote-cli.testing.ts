import { afterEach, beforeEach, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ConnectBody, type ConnectOutcomeKind, machineFingerprint, type RemoteAccessStatus } from '@orch/shared'
import type { RemoteAccessEnv } from './modules/remote-access/addresses.service'
import { fingerprintOf } from './modules/remote-access/device-proof.service'
import { DevicesRepository } from './modules/remote-access/devices.repository'
import { DevicesService } from './modules/remote-access/devices.service'
import { AmbiguousDevice, ConnectError, UnknownDevice } from './modules/remote-access/remote-access.errors'
import { createRemoteAccessRoutes } from './modules/remote-access/remote-access.routes'
import { DEFAULT_SERVER_URL } from './modules/remote-access/remote-access.service'
import { NoRemoteSessions } from './modules/remote-access/remote-access.testing'
import { createTestMachineKey } from './modules/tunnel/tunnel.testing'
import { type CallHost, createHostCaller, runRemote } from './remote-cli'

// Test-only harness for `host:remote`: a fake remote access service behind the
// real routes, on a free port or none at all, and a runner that checks nothing
// printed holds a secret. Each test file calls `useRemoteCliHarness()` once.
// Never imported by production code.

export const key = `oek_${'k'.repeat(43)}`
export const email = 'ada.lovelace@example.com'
export const machineKey = createTestMachineKey()
const account = { name: 'Ada', maskedEmail: 'a***@example.com' }
export const linked = { ...account, serverUrl: DEFAULT_SERVER_URL, linkedAt: '2026-11-04T12:00:00.000Z' }

/** A browser device: an id, the fingerprint its page shows and its public key, which no output may hold. */
function device(seed: number) {
  const id = Buffer.from(new Uint8Array(32).fill(seed)).toString('base64url')
  const coordinate = (salt: number) => Buffer.from(new Uint8Array(32).fill(seed + salt)).toString('base64url')
  const publicKey = { kty: 'EC', crv: 'P-256', x: coordinate(100), y: coordinate(150) } as const
  return { id, fingerprint: fingerprintOf(id), publicKey }
}
export const [alice, bob, carol] = [device(1), device(2), device(3)]
export const MINUTE = 60_000

/** Stands in for `RemoteAccessService` behind the real routes, recording each call it gets. */
export class FakeRemoteAccess extends NoRemoteSessions {
  current: RemoteAccessStatus = {
    serverUrl: DEFAULT_SERVER_URL,
    serverUrlIsDefault: true,
    defaultServerUrl: DEFAULT_SERVER_URL,
    clientUrl: 'https://app.example.com',
    serverUrlSetBy: null,
    clientUrlSetBy: null,
    machineId: machineKey.machineId,
    machineFingerprint: machineFingerprint(machineKey.machineId),
    tunnel: 'off',
    linkedAccount: null,
    connectRequest: null,
    connectOutcome: null,
  }
  calls: [string, unknown][] = []
  /** How many times the status was asked for. */
  statusCalls = 0
  /** What `connect` throws, standing for a host refusal. */
  connectError: ConnectError | null = null
  /** Runs while `connect` is on its way, before the server holds the request. */
  onConnect: (() => Promise<void>) | null = null
  /** What the owner does at each status read while the request waits. Accepting it is the default. */
  owner: (host: FakeRemoteAccess) => void = (host) => host.link()
  /** Whether `disconnect` says the server removed the machine. */
  removed = true
  /** The host's clock, in milliseconds, which the CLI's `now` reads too. */
  clock = Date.UTC(2026, 10, 6, 12)
  /** The real device lists, saved apart from the CLI's data folder, which a running host's commands never read. */
  devices = new DevicesService(new DevicesRepository(join(dir, 'host-devices.json')), () => this.clock)

  status() {
    this.statusCalls++
    if (this.current.connectRequest) this.owner(this)
    return this.current
  }
  async connect(input: ConnectBody) {
    this.calls.push(['connect', input])
    if (this.connectError) throw this.connectError
    this.current = { ...this.current, serverUrl: input.serverUrl, tunnel: 'connected', connectOutcome: null }
    await this.onConnect?.()
    if (this.current.connectOutcome) throw new ConnectError(409, this.current.connectOutcome.message)
    const expiresAt = new Date(this.clock + 15 * MINUTE).toISOString()
    this.current = { ...this.current, connectRequest: { expiresAt } }
    return this.current
  }
  /** The owner accepted: the machine is connected to the account. */
  link() {
    const linkedAccount = { ...linked, serverUrl: this.current.serverUrl }
    this.current = { ...this.current, linkedAccount, connectRequest: null }
  }
  /** The request ended unlinked as `kind`, and the tunnel stopped. */
  end(kind: ConnectOutcomeKind, message: string) {
    this.current = { ...this.current, tunnel: 'off', connectRequest: null, connectOutcome: { kind, message } }
  }
  cancelConnect() {
    this.calls.push(['cancelConnect', {}])
    if (this.current.tunnel !== 'off' && !this.current.linkedAccount) {
      this.end('cancelled', 'The connect request was cancelled. Nothing was linked')
    }
    return this.current
  }
  async disconnect() {
    this.calls.push(['disconnect', {}])
    this.current = { ...this.current, tunnel: 'off', linkedAccount: null }
    return { status: this.current, removedFromAccount: this.removed }
  }
  listDevices() {
    return this.devices.list()
  }
  approveDevice(fingerprint: string) {
    this.calls.push(['approveDevice', fingerprint])
    const result = this.devices.approve(fingerprint)
    if (result === 'none') throw new UnknownDevice(fingerprint)
    if (result === 'several') throw new AmbiguousDevice(fingerprint)
    return this.devices.list()
  }
  auditLog = () => ({ entries: [] })
  removeDevice(id: string) {
    this.calls.push(['removeDevice', id])
    this.devices.remove(id)
    return this.devices.list()
  }
}

export let dir: string
export let host: FakeRemoteAccess
let server: ReturnType<typeof Bun.serve> | null

/** Gives each test a temp data folder and a fresh fake host, and stops the host's server after. */
export function useRemoteCliHarness() {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orch-remote-cli-'))
    host = new FakeRemoteAccess()
    server = null
  })

  afterEach(() => {
    server?.stop(true)
    rmSync(dir, { recursive: true, force: true })
  })
}

/** Serves the real remote access routes over `host` on a free port, and answers its base URL. */
export function runningHost(): string {
  server = Bun.serve({ port: 0, fetch: createRemoteAccessRoutes({ remoteAccess: host }).fetch })
  return `http://127.0.0.1:${server.port}`
}

/** A base URL nothing listens on: a server is started to get a free port, then stopped. */
export function stoppedHost(): string {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const url = `http://127.0.0.1:${probe.port}`
  probe.stop(true)
  return url
}

/** The Ctrl-C handler the CLI that `run` started has installed. Null while none is. */
let onCtrlC: (() => void) | null = null

/** Presses Ctrl-C in the CLI that `run` started, while it catches it. */
export function pressCtrlC() {
  onCtrlC?.()
}

/**
 * Runs the CLI with `answers` as the lines typed, and answers its exit code and
 * everything it printed, which must never hold the key or the machine's private key.
 * `hostGone` stands for the host stopping: once it is true, every call finds no host.
 */
export async function run(
  baseUrl: string,
  args: string[],
  options: {
    env?: RemoteAccessEnv
    answers?: (string | null)[]
    onPrompt?: () => void
    hostGone?: () => boolean
  } = {},
) {
  const answers = [...(options.answers ?? [])]
  const lines: string[] = []
  const caller = createHostCaller(baseUrl)
  const callHost: CallHost = (endpoint, input) =>
    options.hostGone?.() ? Promise.resolve(null) : caller(endpoint, input)
  const code = await runRemote(args, {
    callHost,
    dataDir: dir,
    env: options.env ?? {},
    prompt: async (question) => {
      lines.push(question)
      options.onPrompt?.()
      return answers.shift() ?? null
    },
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    now: () => host.clock,
    onInterrupt: (handler) => {
      onCtrlC = handler
      return () => {
        if (onCtrlC === handler) onCtrlC = null
      }
    },
    pollMs: 1,
  })
  const text = lines.join('\n')
  expect(text).not.toContain(key)
  expect(text).not.toContain(machineKey.privateKey)
  for (const { id, publicKey } of [alice, bob, carol]) {
    for (const value of [id, publicKey.x, publicKey.y]) expect(text).not.toContain(value)
  }
  // Nothing is left catching Ctrl-C once the command is done.
  expect(onCtrlC).toBeNull()
  return { code, text }
}
