import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LinkBody, PreviewLinkBody, RemoteAccessStatus, UpdateRemoteAccessBody } from '@orch/shared'
import { accessKeysPath } from './modules/access/access.repository'
import { machineIdFromSecret } from './modules/access/access.service'
import { fingerprintOf } from './modules/remote-access/device-proof.service'
import { DevicesRepository, devicesPath } from './modules/remote-access/devices.repository'
import { DevicesService } from './modules/remote-access/devices.service'
import { linkedAccountPath } from './modules/remote-access/linked-account.repository'
import { AmbiguousDevice, LinkError, UnknownDevice } from './modules/remote-access/remote-access.errors'
import { remoteAccessPath } from './modules/remote-access/remote-access.repository'
import { createRemoteAccessRoutes } from './modules/remote-access/remote-access.routes'
import { DEFAULT_SERVER_URL, type RemoteAccessEnv } from './modules/remote-access/remote-access.service'
import { NoRemoteSessions } from './modules/remote-access/remote-access.testing'
import { machineSecretFile } from './modules/tunnel/tunnel.repository'
import { createHostCaller, runRemote } from './remote-cli'

const key = `oek_${'k'.repeat(43)}`
const secret = 's'.repeat(43)
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
    enabled: true,
    serverUrl: DEFAULT_SERVER_URL,
    serverUrlIsDefault: true,
    clientUrl: 'https://app.example.com',
    serverUrlFromEnv: false,
    clientUrlFromEnv: false,
    machineId: 'm1',
    tunnel: 'connected',
    linkedAccount: null,
  }
  calls: [string, unknown][] = []
  /** The account the key belongs to, as the server names it. */
  account = account
  /** What `previewLink` and `link` throw, standing for a host refusal. */
  linkError: LinkError | null = null
  /** The host's clock, in milliseconds, which the CLI's `now` reads too. */
  clock = Date.UTC(2026, 10, 6, 12)
  /** The real device lists, saved apart from the CLI's `.data/`, which a running host's commands never read. */
  devices = new DevicesService(new DevicesRepository(join(dir, 'host-devices.json')), () => this.clock)

  status() {
    return this.current
  }
  update(input: UpdateRemoteAccessBody) {
    this.calls.push(['update', input])
    this.current = { ...this.current, enabled: input.enabled, tunnel: input.enabled ? 'connecting' : 'off' }
    return this.current
  }
  async previewLink(input: PreviewLinkBody) {
    this.calls.push(['previewLink', input])
    if (this.linkError) throw this.linkError
    return {
      serverUrl: this.current.serverUrl,
      serverUrlIsDefault: this.current.serverUrlIsDefault,
      account: this.account,
      fingerprint: key.slice(-4),
      expiresAt: '2026-11-04T12:15:00.000Z',
    }
  }
  async link(input: LinkBody) {
    this.calls.push(['link', input])
    this.current = { ...this.current, linkedAccount: { ...linked, serverUrl: input.serverUrl } }
    return this.current
  }
  unlink() {
    this.calls.push(['unlink', {}])
    this.current = { ...this.current, linkedAccount: null }
    return this.current
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
  mkdirSync(join(dir, '.data'))
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
 * everything it printed, which must never hold the key or the machine secret.
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
    hostRoot: dir,
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
  expect(text).not.toContain(secret)
  for (const { id, publicKey } of [alice, bob, carol]) {
    for (const value of [id, publicKey.x, publicKey.y]) expect(text).not.toContain(value)
  }
  return { code, text }
}

describe('host:remote with the host running', () => {
  test('status prints the setting, and on/server send one update keeping the other fields', async () => {
    const url = runningHost()
    host.current.linkedAccount = linked

    const status = await run(url, ['status'])
    expect(status.code).toBe(0)
    expect(status.text).toContain(`${DEFAULT_SERVER_URL} (default)`)
    expect(status.text).toContain('on, tunnel connected')
    expect(status.text).toContain('Machine id:     m1')
    expect(status.text).toContain('Ada (a***@example.com)')

    expect((await run(url, ['off'])).text).toContain('off, tunnel off')
    expect(host.calls).toEqual([['update', { enabled: false, serverUrl: '', clientUrl: 'https://app.example.com' }]])

    host.calls = []
    expect((await run(url, ['server', 'ws://127.0.0.1:4600'])).code).toBe(0)
    expect((await run(url, ['server', 'ws://example.com'])).text).toContain('must be wss://<host>')
    expect(host.calls).toEqual([
      ['update', { enabled: false, serverUrl: 'ws://127.0.0.1:4600', clientUrl: 'https://app.example.com' }],
    ])
  })

  test('server is refused when SERVER_URL sets the address, and on when the setting file is not valid', async () => {
    const url = runningHost()
    host.current.serverUrlFromEnv = true
    const refused = await run(url, ['server', 'wss://host'])
    expect(refused.code).toBe(1)
    expect(refused.text).toContain('SERVER_URL sets the server address; change it there')

    writeFileSync(remoteAccessPath(dir), '{ broken')
    expect((await run(url, ['on'])).code).toBe(1)
    expect(readFileSync(remoteAccessPath(dir), 'utf8')).toBe('{ broken')
    expect(host.calls).toEqual([])
  })

  test('link previews the key, asks, and links only on yes', async () => {
    const url = runningHost()
    host.current = { ...host.current, serverUrl: 'wss://other.example.com', serverUrlIsDefault: false }

    const no = await run(url, ['link', key], { answers: [''] })
    expect(no.code).toBe(1)
    expect(no.text).toContain('wss://other.example.com')
    expect(no.text).toContain('Warning:')
    expect(no.text).toContain('Ada (a***@example.com)')
    expect(no.text).toContain(`Fingerprint: ${key.slice(-4)}`)
    expect(no.text).toContain('Link this machine to Ada? [y/N]')
    expect(no.text).toContain('Not linked')
    expect((await run(url, ['link', key], { answers: [null] })).code).toBe(1)
    expect(host.calls.map(([name]) => name)).toEqual(['previewLink', 'previewLink'])

    const yes = await run(url, ['link', key], { answers: ['YES'] })
    expect(yes.code).toBe(0)
    expect(yes.text).toContain('Linked: Ada')
    expect(host.calls.at(-1)).toEqual(['link', { key, serverUrl: 'wss://other.example.com' }])
  })

  test('link --yes skips the prompt, a host refusal is printed, and a bad key sends nothing', async () => {
    const url = runningHost()
    // A name that would erase the warning and fake a line in a terminal.
    host.account = { name: 'Eve\x1b[1A\x1b[2K\nFingerprint: kkkk', maskedEmail: 'e***@example.com' }
    const yes = await run(url, ['link', '--yes', key])
    expect(yes.code).toBe(0)
    expect(yes.text).toContain('Fingerprint:')
    expect(yes.text).not.toContain('[y/N]')
    expect(yes.text).not.toContain('\x1b')
    expect(yes.text).toContain('Account:     Eve?[1A?[2K?Fingerprint: kkkk (e***@example.com)')

    host.calls = []
    host.linkError = new LinkError(409, 'Turn remote access on and wait until it is connected')
    const refused = await run(url, ['link', key, '--yes'])
    expect(refused.code).toBe(1)
    expect(refused.text).toContain('Turn remote access on and wait until it is connected')
    expect(host.calls.map(([name]) => name)).toEqual(['previewLink'])

    host.calls = []
    expect((await run(url, ['link', 'oek_short'])).code).toBe(1)
    expect(host.calls).toEqual([])
  })

  test('unlink forgets the account, and says so when none is linked', async () => {
    const url = runningHost()
    expect((await run(url, ['unlink'])).text).toContain('No account is linked')
    host.current.linkedAccount = linked
    const unlink = await run(url, ['unlink'])
    expect(unlink.code).toBe(0)
    expect(unlink.text).toContain('forgotten on this machine only')
    expect(host.calls).toEqual([['unlink', {}]])
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
      expect(no.text).toContain(
        `Approve ${typed}? It will be able to open this machine through the linked account. [y/N]`,
      )
      expect(no.text).toContain('Not approved')
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
  test('status reads the files without creating a secret or keys', async () => {
    const url = stoppedHost()
    const empty = await run(url, ['status'], { env: { SERVER_URL: 'ws://127.0.0.1:4600' } })
    expect(empty.code).toBe(0)
    expect(empty.text).toContain('ws://127.0.0.1:4600 (from SERVER_URL)')
    expect(empty.text).toContain('host not running')
    expect(empty.text).toContain('none yet')
    expect(empty.text).toContain('not linked')
    expect(existsSync(machineSecretFile(dir))).toBe(false)
    expect(existsSync(accessKeysPath(dir))).toBe(false)

    writeFileSync(machineSecretFile(dir), secret)
    writeFileSync(remoteAccessPath(dir), JSON.stringify({ enabled: true, serverUrl: 'wss://host', clientUrl: null }))
    writeFileSync(linkedAccountPath(dir), JSON.stringify(linked))
    const saved = await run(url, ['status'])
    expect(saved.text).toContain('Server address: wss://host\n')
    expect(saved.text).toContain('on, tunnel host not running')
    expect(saved.text).toContain(machineIdFromSecret(secret))
    expect(saved.text).toContain('Ada (a***@example.com)')
  })

  test('server, on and off rewrite only their field, and leave a broken file alone', async () => {
    const url = stoppedHost()
    expect((await run(url, ['server', ' wss://host '])).code).toBe(0)
    expect(JSON.parse(readFileSync(remoteAccessPath(dir), 'utf8'))).toEqual({
      enabled: false,
      serverUrl: 'wss://host',
      clientUrl: null,
    })
    writeFileSync(
      remoteAccessPath(dir),
      JSON.stringify({ enabled: false, serverUrl: 'wss://host', clientUrl: 'https://c' }),
    )
    expect((await run(url, ['on'])).text).toContain('next starts')
    expect(JSON.parse(readFileSync(remoteAccessPath(dir), 'utf8'))).toEqual({
      enabled: true,
      serverUrl: 'wss://host',
      clientUrl: 'https://c',
    })

    expect((await run(url, ['server', 'https://x'])).code).toBe(1)
    writeFileSync(remoteAccessPath(dir), '{ broken')
    for (const args of [['on'], ['off'], ['server', 'wss://host']]) expect((await run(url, args)).code).toBe(1)
    expect(readFileSync(remoteAccessPath(dir), 'utf8')).toBe('{ broken')
  })

  test('link refuses without writing, and unlink removes even a broken account file', async () => {
    const url = stoppedHost()
    const link = await run(url, ['link', key, '--yes'])
    expect(link.code).toBe(1)
    expect(link.text).toContain('Start the host and turn remote access on, then run this again')
    expect(existsSync(machineSecretFile(dir))).toBe(false)
    expect(existsSync(linkedAccountPath(dir))).toBe(false)

    writeFileSync(linkedAccountPath(dir), 'not json')
    expect((await run(url, ['unlink'])).text).toContain('forgotten on this machine only')
    expect(existsSync(linkedAccountPath(dir))).toBe(false)
    const again = await run(url, ['unlink'])
    expect(again.code).toBe(0)
    expect(again.text).toContain('No account is linked')
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
    const wrong = [[], ['nope'], ['server'], ['link'], ['devices', 'approve'], ['devices', 'remove', 'A', '--yes']]
    for (const args of wrong) {
      const { code, text } = await run(url, args)
      expect(code).toBe(1)
      for (const command of [
        'status',
        'server <url>',
        'on',
        'off',
        'link <key> [--yes]',
        'unlink',
        'devices approve <fingerprint> [--yes]',
        'devices remove <fingerprint>',
      ])
        expect(text).toContain(command)
    }
  })
})
