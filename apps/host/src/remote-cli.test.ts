import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ConnectBody, machineFingerprint, type RemoteAccessStatus } from '@orch/shared'
import { accessKeysPath } from './modules/access/access.repository'
import type { RemoteAccessEnv } from './modules/remote-access/addresses.service'
import { fingerprintOf } from './modules/remote-access/device-proof.service'
import { DevicesRepository, devicesPath } from './modules/remote-access/devices.repository'
import { DevicesService } from './modules/remote-access/devices.service'
import { linkedAccountPath } from './modules/remote-access/linked-account.repository'
import { AmbiguousDevice, ConnectError, UnknownDevice } from './modules/remote-access/remote-access.errors'
import { createRemoteAccessRoutes } from './modules/remote-access/remote-access.routes'
import { DEFAULT_SERVER_URL } from './modules/remote-access/remote-access.service'
import { NoRemoteSessions } from './modules/remote-access/remote-access.testing'
import { machineKeyFile } from './modules/tunnel/tunnel.repository'
import { createTestMachineKey } from './modules/tunnel/tunnel.testing'
import { createHostCaller, runRemote } from './remote-cli'
import { REMOVE_IN_CLIENT } from './remote-cli-connect'

const key = `oek_${'k'.repeat(43)}`
const email = 'ada.lovelace@example.com'
const machineKey = createTestMachineKey()
const account = { name: 'Ada', maskedEmail: 'a***@example.com' }
const linked = { ...account, serverUrl: DEFAULT_SERVER_URL, linkedAt: '2026-11-04T12:00:00.000Z' }

/** A browser device: an id, the fingerprint its page shows and its public key, which no output may hold. */
function device(seed: number) {
  const id = Buffer.from(new Uint8Array(32).fill(seed)).toString('base64url')
  const coordinate = (salt: number) => Buffer.from(new Uint8Array(32).fill(seed + salt)).toString('base64url')
  const publicKey = { kty: 'EC', crv: 'P-256', x: coordinate(100), y: coordinate(150) } as const
  return { id, fingerprint: fingerprintOf(id), publicKey }
}
const [alice, bob, carol] = [device(1), device(2), device(3)]
const MINUTE = 60_000

/** Stands in for `RemoteAccessService` behind the real routes, recording each call it gets. */
class FakeRemoteAccess extends NoRemoteSessions {
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
  }
  calls: [string, unknown][] = []
  /** How many times the status was asked for. */
  statusCalls = 0
  /** What `connect` throws, standing for a host refusal. */
  connectError: ConnectError | null = null
  /** Whether `disconnect` says the server removed the machine. */
  removed = true
  /** The host's clock, in milliseconds, which the CLI's `now` reads too. */
  clock = Date.UTC(2026, 10, 6, 12)
  /** The real device lists, saved apart from the CLI's data folder, which a running host's commands never read. */
  devices = new DevicesService(new DevicesRepository(join(dir, 'host-devices.json')), () => this.clock)

  status() {
    this.statusCalls++
    return this.current
  }
  async connect(input: ConnectBody) {
    this.calls.push(['connect', input])
    if (this.connectError) throw this.connectError
    const linkedAccount = { ...linked, serverUrl: input.serverUrl }
    this.current = { ...this.current, serverUrl: input.serverUrl, tunnel: 'connected', linkedAccount }
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

let dir: string
let host: FakeRemoteAccess
let server: ReturnType<typeof Bun.serve> | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-remote-cli-'))
  host = new FakeRemoteAccess()
  server = null
})

afterEach(() => {
  server?.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

/** Serves the real remote access routes over `host` on a free port, and answers its base URL. */
function runningHost(): string {
  server = Bun.serve({ port: 0, fetch: createRemoteAccessRoutes({ remoteAccess: host }).fetch })
  return `http://127.0.0.1:${server.port}`
}

/** A base URL nothing listens on: a server is started to get a free port, then stopped. */
function stoppedHost(): string {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const url = `http://127.0.0.1:${probe.port}`
  probe.stop(true)
  return url
}

/**
 * Runs the CLI with `answers` as the lines typed, and answers its exit code and
 * everything it printed, which must never hold the key or the machine's private key.
 */
async function run(
  baseUrl: string,
  args: string[],
  options: { env?: RemoteAccessEnv; answers?: (string | null)[]; onPrompt?: () => void } = {},
) {
  const answers = [...(options.answers ?? [])]
  const lines: string[] = []
  const code = await runRemote(args, {
    callHost: createHostCaller(baseUrl),
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
  })
  const text = lines.join('\n')
  expect(text).not.toContain(key)
  expect(text).not.toContain(machineKey.privateKey)
  for (const { id, publicKey } of [alice, bob, carol]) {
    for (const value of [id, publicKey.x, publicKey.y]) expect(text).not.toContain(value)
  }
  return { code, text }
}

describe('host:remote with the host running', () => {
  test('status prints the address, the connection, the machine and the account', async () => {
    const url = runningHost()
    host.current = { ...host.current, tunnel: 'connected', linkedAccount: linked }

    const status = await run(url, ['status'])
    expect(status.code).toBe(0)
    expect(status.text).toContain(`Server address: ${DEFAULT_SERVER_URL} (default)`)
    expect(status.text).toContain('Connection:     connected, tunnel connected')
    expect(status.text).toContain(`Machine id:     ${machineKey.machineId}`)
    expect(status.text).toContain(`Machine key:    ${machineFingerprint(machineKey.machineId)}\n`)
    expect(status.text).toContain(`Account:        Ada (a***@example.com) through ${DEFAULT_SERVER_URL}`)
  })

  test('connect shows the server, the email and the key ending, asks, and connects only on yes', async () => {
    const url = runningHost()
    const args = ['connect', '--email', email, '--key', key, '--server', 'wss://other.example.com']

    const no = await run(url, args, { answers: [''] })
    expect(no.code).toBe(1)
    expect(no.text.split('\n')).toEqual([
      'Server:      wss://other.example.com',
      'Warning:     this is not the default server. Connect only if you run it or trust who does.',
      `Email:       ${email}`,
      `Key ends in: ${key.slice(-4)}`,
      'Connect this machine to this account? [y/N] ',
      'Not connected',
    ])
    expect((await run(url, args, { answers: [null] })).code).toBe(1)
    expect(host.calls).toEqual([])

    const yes = await run(url, args, { answers: ['YES'] })
    expect(yes.code).toBe(0)
    expect(yes.text).toContain('Connected to Ada (a***@example.com) through wss://other.example.com')
    // The email shows only in the line the owner checks.
    expect(yes.text.split(email)).toHaveLength(2)
    expect(host.calls).toEqual([['connect', { email, key, serverUrl: 'wss://other.example.com' }]])

    // Connected now, so a second connect is refused before anything is sent.
    const again = await run(url, ['connect', `--email=${email}`, `--key=${key}`, '--yes'])
    expect(again).toMatchObject({ code: 1, text: expect.stringContaining('already connected to Ada') })
    expect(host.calls).toHaveLength(1)
  })

  test('connect uses the default without --server, or the address a variable sets, and --yes skips the question', async () => {
    const url = runningHost()
    const yes = await run(url, ['connect', '--yes', '--key', key, '--email', ` ${email} `])
    expect(yes.code).toBe(0)
    expect(yes.text).not.toContain('[y/N]')
    expect(yes.text).not.toContain('Warning:')
    expect(host.calls).toEqual([['connect', { email, key, serverUrl: DEFAULT_SERVER_URL }]])

    host.calls = []
    host.current = {
      ...host.current,
      linkedAccount: null,
      serverUrl: 'ws://127.0.0.1:4600',
      serverUrlSetBy: 'SERVER_URL',
    }
    const other = await run(url, ['connect', '--email', email, '--key', key, '--server', 'wss://other.example.com'])
    expect(other).toEqual({
      code: 1,
      text: 'SERVER_URL sets the server address to ws://127.0.0.1:4600. Leave out --server',
    })
    expect((await run(url, ['connect', '--email', email, '--key', key, '--yes'])).code).toBe(0)
    expect(host.calls).toEqual([['connect', { email, key, serverUrl: 'ws://127.0.0.1:4600' }]])

    // A host refusal is printed as it is, and a name from the server can't fake a line.
    host.current = { ...host.current, linkedAccount: null }
    host.connectError = new ConnectError(400, "This key is unknown, used or expired, or the email doesn't match")
    const refused = await run(url, ['connect', '--email', email, '--key', key, '--yes'])
    expect(refused).toMatchObject({ code: 1, text: expect.stringContaining('This key is unknown') })
  })

  test('a malformed key, email or server, and the old commands, are refused before the host is called', async () => {
    const url = runningHost()
    const secret = 'oek_secret'
    const cases: [string[], string][] = [
      [['connect', '--email', email, '--key', secret], 'That is not an enrollment key.'],
      [['connect', '--email', 'secret@', '--key', key], 'That is not an email address'],
      [['connect', '--email', email, '--key', key, '--server', 'ws://secret.example.com'], 'The server address must'],
    ]
    for (const [args, message] of cases) {
      const { code, text } = await run(url, args)
      expect([code, text.startsWith(message)]).toEqual([1, true])
      for (const value of [secret, 'secret@', 'secret.example.com', email]) expect(text).not.toContain(value)
    }
    for (const args of [['link', key], ['unlink'], ['server', 'wss://x'], ['on'], ['off'], ['connect', '--key', key]]) {
      const { code, text } = await run(url, args)
      expect([args, code, text.startsWith('Usage:')]).toEqual([args, 1, true])
    }
    expect(host.statusCalls).toBe(0)
  })

  test("disconnect asks, and says when the machine is still on the account's list", async () => {
    const url = runningHost()
    expect((await run(url, ['disconnect'])).text).toBe('This machine is not connected')
    host.current = { ...host.current, tunnel: 'connected', linkedAccount: linked }

    const no = await run(url, ['disconnect'], { answers: ['n'] })
    expect(no.code).toBe(1)
    expect(no.text).toContain('Disconnect this machine from Ada (a***@example.com)? [y/N]')
    expect(host.calls).toEqual([])
    const yes = await run(url, ['disconnect'], { answers: ['y'] })
    expect(yes.code).toBe(0)
    expect(yes.text).toContain('Disconnected.')
    expect(yes.text).not.toContain(REMOVE_IN_CLIENT)

    host.current = { ...host.current, linkedAccount: linked }
    host.removed = false
    const kept = await run(url, ['disconnect', '--yes'])
    expect(kept.code).toBe(0)
    expect(kept.text).not.toContain('[y/N]')
    expect(kept.text).toContain(REMOVE_IN_CLIENT)
    expect(host.calls).toEqual([
      ['disconnect', {}],
      ['disconnect', {}],
    ])
  })

  test('devices lists waiting then approved devices with their ages, and status counts them', async () => {
    const url = runningHost()
    expect((await run(url, ['devices'])).text).toContain('No devices are approved or waiting')
    expect((await run(url, ['status'])).text).toContain('Devices:        0 approved, 0 waiting')

    host.devices.recordPending(alice.id, alice.publicKey)
    host.devices.approve(alice.fingerprint)
    host.clock += 2 * 24 * 60 * MINUTE
    host.devices.recordPending(bob.id, bob.publicKey)
    host.clock += MINUTE
    host.devices.recordPending(carol.id, carol.publicKey)
    host.clock += 3 * MINUTE

    const list = await run(url, ['devices'])
    expect(list.code).toBe(0)
    expect(list.text.split('\n')).toEqual([
      `${carol.fingerprint}  waiting, seen 3 min ago`,
      `${bob.fingerprint}  waiting, seen 4 min ago`,
      `${alice.fingerprint}  approved 2 days ago`,
    ])
    const status = await run(url, ['status'])
    expect(status.code).toBe(0)
    expect(status.text).toContain('Devices:        1 approved, 2 waiting')
  })

  test('devices approve asks, and approves the matching device only on yes', async () => {
    const url = runningHost()
    host.devices.recordPending(alice.id, alice.publicKey)
    const typed = alice.fingerprint.replaceAll('-', '').toLowerCase()

    for (const answer of ['', 'n', null]) {
      const no = await run(url, ['devices', 'approve', typed], { answers: [answer] })
      expect(no.code).toBe(1)
      expect(no.text).toContain('Approve only a fingerprint shown in your own browser.')
      expect(no.text).toContain(`Approve ${typed}? It will be able to open this machine remotely. [y/N]`)
      // No answer at all, as when stdin isn't a terminal, says how to approve instead of a bare refusal.
      expect(no.text).toContain(answer === null ? 'No answer could be read, so nothing was approved' : 'Not approved')
    }
    expect(host.calls).toEqual([])

    const yes = await run(url, ['devices', 'approve', typed], { answers: ['Yes'] })
    expect(yes.code).toBe(0)
    expect(yes.text).toContain(`Approved ${alice.fingerprint}`)
    expect(host.calls).toEqual([['approveDevice', typed]])

    const again = await run(url, ['devices', 'approve', alice.fingerprint])
    expect(again.code).toBe(0)
    expect(again.text).toContain(`${alice.fingerprint} is already approved`)
    expect(again.text).not.toContain('[y/N]')
    expect(host.calls).toHaveLength(1)
  })

  test('devices approve --yes skips the question, and a fingerprint the host matches to no device or two exits 1', async () => {
    const url = runningHost()
    host.devices.recordPending(alice.id, alice.publicKey)
    host.devices.recordPending(bob.id, bob.publicKey)
    const yes = await run(url, ['devices', 'approve', '--yes', alice.fingerprint])
    expect(yes.code).toBe(0)
    expect(yes.text).not.toContain('[y/N]')
    expect((await run(url, ['devices', 'approve', bob.fingerprint, '--yes'])).code).toBe(0)
    expect(host.calls).toEqual([
      ['approveDevice', alice.fingerprint],
      ['approveDevice', bob.fingerprint],
    ])

    const notWaiting = (typed: string) =>
      `No browser with the fingerprint ${typed} is waiting. Open this machine in your own browser and type the fingerprint it shows.`
    for (const typed of [carol.fingerprint, 'nope']) {
      const unknown = await run(url, ['devices', 'approve', typed, '--yes'])
      expect(unknown.code).toBe(1)
      expect(unknown.text).toBe(notWaiting(typed))
    }
    host.devices.recordPending(carol.id, carol.publicKey)
    const expired = await run(url, ['devices', 'approve', carol.fingerprint], {
      answers: ['y'],
      onPrompt: () => host.devices.remove(carol.id),
    })
    expect(expired.code).toBe(1)
    expect(expired.text).toContain(notWaiting(carol.fingerprint))

    // Two waiting devices with one fingerprint (the id's last character is past it): the host approves neither.
    for (const last of ['A', 'B']) host.devices.recordPending(`${carol.id.slice(0, -1)}${last}`, carol.publicKey)
    const several = await run(url, ['devices', 'approve', carol.fingerprint, '--yes'])
    expect(several.code).toBe(1)
    expect(several.text).toContain('More than one browser has the fingerprint')
    expect(host.devices.list().approved.map((d) => d.id)).toEqual([bob.id, alice.id])
  })

  test('devices remove dismisses a waiting device or revokes an approved one', async () => {
    const url = runningHost()
    host.devices.recordPending(alice.id, alice.publicKey)
    host.devices.approve(alice.fingerprint)
    host.devices.recordPending(bob.id, bob.publicKey)

    expect((await run(url, ['devices', 'remove', bob.fingerprint])).text).toContain(`Dismissed ${bob.fingerprint}`)
    const revoked = await run(url, ['devices', 'remove', alice.fingerprint])
    expect(revoked.code).toBe(0)
    expect(revoked.text).toContain(`Revoked ${alice.fingerprint}. The sockets it had open are closed.`)
    expect(host.calls).toEqual([
      ['removeDevice', bob.id],
      ['removeDevice', alice.id],
    ])

    expect((await run(url, ['devices', 'remove', alice.fingerprint])).code).toBe(1)
    expect(host.calls).toHaveLength(2)
  })
})

describe('host:remote with the host stopped', () => {
  test('status reads the files without creating a machine key or access keys', async () => {
    const url = stoppedHost()
    const empty = await run(url, ['status'], { env: { SERVER_URL: 'ws://127.0.0.1:4600' } })
    expect(empty.code).toBe(0)
    expect(empty.text).toContain('ws://127.0.0.1:4600 (from SERVER_URL)')
    expect(empty.text).toContain('Connection:     not connected, tunnel host not running')
    expect(empty.text).toContain('Machine id:     none yet')
    expect(empty.text).toContain('Machine key:    none yet')
    expect(empty.text).toContain('Account:        not connected')
    expect(existsSync(machineKeyFile(dir))).toBe(false)
    expect(existsSync(accessKeysPath(dir))).toBe(false)

    writeFileSync(join(dir, 'machine-key'), machineKey.pem)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ relayUrl: 'wss://host' }))
    writeFileSync(join(dir, 'linked-account.json'), JSON.stringify(linked))
    const saved = await run(url, ['status'])
    expect(saved.text).toContain('Server address: wss://host\n')
    expect(saved.text).toContain('Connection:     connected, tunnel host not running')
    expect(saved.text).toContain(machineKey.machineId)
    expect(saved.text).toContain(`Machine key:    ${machineFingerprint(machineKey.machineId)}\n`)
    expect(saved.text).toContain('Ada (a***@example.com)')

    writeFileSync(join(dir, 'linked-account.json'), 'not json')
    const broken = await run(url, ['status'])
    expect(broken.code).toBe(1)
    expect(broken.text).toContain('Connection:     unknown')
  })

  test('connect and disconnect need the running host, and write nothing', async () => {
    const url = stoppedHost()
    writeFileSync(linkedAccountPath(dir), JSON.stringify(linked))
    for (const args of [
      ['connect', '--email', email, '--key', key, '--yes'],
      ['disconnect', '--yes'],
    ]) {
      expect(await run(url, args)).toEqual({ code: 1, text: 'No host is running. Start it, then run this again' })
    }
    expect(existsSync(machineKeyFile(dir))).toBe(false)
    expect(readFileSync(linkedAccountPath(dir), 'utf8')).toBe(JSON.stringify(linked))
  })

  test('devices lists and removes the approved devices in the file, and approve needs the host', async () => {
    const url = stoppedHost()
    const file = devicesPath(dir)
    const missing = await run(url, ['devices'])
    expect(missing.code).toBe(0)
    expect(missing.text).toContain('No devices are approved')
    expect((await run(url, ['devices', 'remove', alice.fingerprint])).code).toBe(1)
    expect(existsSync(file)).toBe(false)

    const approvedAt = (ms: number) => new Date(host.clock - ms).toISOString()
    new DevicesRepository(file).save([
      { id: alice.id, publicKey: alice.publicKey, approvedAt: approvedAt(3 * 24 * 60 * MINUTE) },
      { id: bob.id, publicKey: bob.publicKey, approvedAt: approvedAt(2 * 60 * MINUTE) },
    ])
    const list = await run(url, ['devices'])
    expect(list.text).toContain(`${bob.fingerprint}  approved 2 hours ago\n${alice.fingerprint}  approved 3 days ago`)
    expect(list.text).toContain('known only to the running host')
    expect((await run(url, ['status'])).text).toContain(
      'Devices:        2 approved, waiting unknown (host not running)',
    )

    const approve = await run(url, ['devices', 'approve', carol.fingerprint, '--yes'])
    expect(approve.code).toBe(1)
    expect(approve.text).toContain('Start the host, then run this again')

    const remove = await run(url, ['devices', 'remove', alice.fingerprint.toLowerCase()])
    expect(remove.code).toBe(0)
    expect(remove.text).toContain(`Revoked ${alice.fingerprint}`)
    expect(new DevicesRepository(file).load().map((saved) => saved.id)).toEqual([bob.id])
    expect((await run(url, ['devices', 'remove', carol.fingerprint])).code).toBe(1)
  })

  test('a devices file that is not valid is reported and never rewritten', async () => {
    const url = stoppedHost()
    writeFileSync(devicesPath(dir), '{ broken')
    for (const args of [['devices'], ['devices', 'remove', alice.fingerprint], ['status']]) {
      const { code, text } = await run(url, args)
      expect(code).toBe(1)
      expect(text).toContain('are not valid')
    }
    expect(readFileSync(devicesPath(dir), 'utf8')).toBe('{ broken')
  })

  test('a missing or unknown command prints the usage', async () => {
    const url = stoppedHost()
    const wrong = [[], ['nope'], ['link'], ['connect'], ['disconnect', 'now'], ['devices', 'approve']]
    for (const args of [...wrong, ['devices', 'remove', 'A', '--yes']]) {
      const { code, text } = await run(url, args)
      expect(code).toBe(1)
      for (const command of [
        'status',
        'connect --email <email> --key <key> [--server <url>] [--yes]',
        'disconnect [--yes]',
        'devices approve <fingerprint> [--yes]',
        'devices remove <fingerprint>',
      ])
        expect(text).toContain(command)
      for (const gone of ['link <key>', 'unlink', '  server <url>', '  on ', '  off ']) expect(text).not.toContain(gone)
    }
  })
})
