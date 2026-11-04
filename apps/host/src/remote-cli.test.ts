import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  LinkBody,
  PreviewLinkBody,
  PreviewLinkResponse,
  RemoteAccessStatus,
  UpdateRemoteAccessBody,
} from '@orch/shared'
import { accessKeysPath } from './modules/access/access.repository'
import { machineIdFromSecret } from './modules/access/access.service'
import { linkedAccountPath } from './modules/remote-access/linked-account.repository'
import { remoteAccessPath } from './modules/remote-access/remote-access.repository'
import { createRemoteAccessRoutes } from './modules/remote-access/remote-access.routes'
import { DEFAULT_SERVER_URL, LinkError, type RemoteAccessEnv } from './modules/remote-access/remote-access.service'
import { machineSecretFile } from './modules/tunnel/tunnel.repository'
import { createHostCaller, runRemote } from './remote-cli'

const key = `oek_${'k'.repeat(43)}`
const secret = 's'.repeat(43)
const account = { name: 'Ada', maskedEmail: 'a***@example.com' }
const linked = { ...account, serverUrl: DEFAULT_SERVER_URL, linkedAt: '2026-11-04T12:00:00.000Z' }

/** Stands in for `RemoteAccessService` behind the real routes, recording each call it gets. */
class FakeRemoteAccess {
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

  status() {
    return this.current
  }
  update(input: UpdateRemoteAccessBody) {
    this.calls.push(['update', input])
    this.current = { ...this.current, enabled: input.enabled, tunnel: input.enabled ? 'connecting' : 'off' }
    return this.current
  }
  async previewLink(input: PreviewLinkBody): Promise<PreviewLinkResponse> {
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
  options: { env?: RemoteAccessEnv; answers?: (string | null)[] } = {},
) {
  const answers = [...(options.answers ?? [])]
  const lines: string[] = []
  const code = await runRemote(args, {
    callHost: createHostCaller(baseUrl),
    hostRoot: dir,
    env: options.env ?? {},
    prompt: async (question) => {
      lines.push(question)
      return answers.shift() ?? null
    },
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  })
  const text = lines.join('\n')
  expect(text).not.toContain(key)
  expect(text).not.toContain(secret)
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

  test('a missing or unknown command prints the usage', async () => {
    const url = stoppedHost()
    for (const args of [[], ['nope'], ['server'], ['link']]) {
      const { code, text } = await run(url, args)
      expect(code).toBe(1)
      for (const command of ['status', 'server <url>', 'on', 'off', 'link <key> [--yes]', 'unlink'])
        expect(text).toContain(command)
    }
  })
})
