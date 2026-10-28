import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RotateAccessResponse, routes, type TunnelState } from '@orch/shared'
import { type AppDeps, createApp } from '../../app'
import { AccessKeyRepository } from '../access/access.repository'
import type { TunnelClientOptions } from '../tunnel/tunnel.service'
import { RemoteAccessRepository, type RemoteAccessSettings } from './remote-access.repository'
import { linkClientUrl, type RemoteAccessEnv, RemoteAccessService } from './remote-access.service'

/** Stands in for `TunnelClient`, recording what the service asks of it. */
class FakeTunnel {
  status: TunnelState = 'off'
  closed: string[][] = []
  constructor(readonly options: TunnelClientOptions) {}
  start() {
    this.status = 'connecting'
  }
  stop() {
    this.status = 'off'
  }
  closeChannels(keyIds: string[]) {
    this.closed.push(keyIds)
  }
}

let dir: string
let tunnels: FakeTunnel[]
let logs: string[]
let spies: Mock<(...args: unknown[]) => void>[]
let service: RemoteAccessService

const settingsFile = () => join(dir, 'remote-access.json')
const keysFile = () => join(dir, 'access-keys.json')
const secretFile = () => join(dir, 'machine-secret')

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

/** Starts a service on the temp dir, with `saved` written first and `env` as the environment. */
function setup(saved?: RemoteAccessSettings | string, env: RemoteAccessEnv = {}) {
  if (saved !== undefined) writeFileSync(settingsFile(), typeof saved === 'string' ? saved : JSON.stringify(saved))
  service = new RemoteAccessService({
    repository: new RemoteAccessRepository(settingsFile()),
    secretFile: secretFile(),
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

const storedKeys = () => new AccessKeyRepository(keysFile()).load()

describe('RemoteAccessService', () => {
  test('a saved setting that is on opens one tunnel at start and creates the default key', () => {
    setup({ enabled: true, serverUrl: 'ws://127.0.0.1:4600', clientUrl: null })
    expect(tunnels.map((t) => t.options.url)).toEqual(['ws://127.0.0.1:4600/tunnel'])
    expect(tunnels[0]?.status).toBe('connecting')
    expect(storedKeys().map((k) => k.name)).toEqual(['default'])
    expect(logs.some((line) => line.includes('Connect link: http://127.0.0.1:4600/#machine='))).toBe(true)
    expect(service.status()).toMatchObject({ enabled: true, serverUrlFromEnv: false, tunnel: 'connecting' })
  })

  test('SERVER_URL and CLIENT_URL override the saved addresses, and SERVER_URL turns the tunnel on', () => {
    const saved = { enabled: false, serverUrl: 'ws://127.0.0.1:4600', clientUrl: 'https://saved.example' }
    const env = { SERVER_URL: 'wss://relay.example.com', CLIENT_URL: 'https://env.example/' }
    setup(saved, env)
    expect(tunnels.map((t) => t.options.url)).toEqual(['wss://relay.example.com/tunnel'])
    expect(service.status()).toMatchObject({
      enabled: true,
      serverUrl: 'wss://relay.example.com',
      clientUrl: 'https://env.example/',
      serverUrlFromEnv: true,
      clientUrlFromEnv: true,
    })
    expect(service.current()?.clientUrl).toBe('https://env.example')

    // The link falls back from `CLIENT_URL` to the saved client address, then to the server address in use.
    expect(linkClientUrl({}, saved)).toBe('https://saved.example')
    expect(linkClientUrl({}, { ...saved, clientUrl: null })).toBe('http://127.0.0.1:4600')
    expect(linkClientUrl({ SERVER_URL: 'wss://relay.example.com' }, { ...saved, clientUrl: null })).toBe(
      'https://relay.example.com',
    )
    expect(linkClientUrl({}, null)).toBeNull()
  })

  test('a missing or invalid setting file leaves remote access off, and an invalid one is logged and kept', () => {
    setup()
    expect(tunnels).toHaveLength(0)
    expect(service.status()).toMatchObject({ enabled: false, serverUrl: null, machineId: null, tunnel: 'off' })
    service.shutdown()

    const hashLike = 'h'.repeat(43)
    const invalid = `{"enabled": true, "serverUrl": "${hashLike}"`
    setup(invalid)
    expect(tunnels).toHaveLength(0)
    expect(readFileSync(settingsFile(), 'utf8')).toBe(invalid)
    expect(logs.some((line) => line.includes('remote-access.json is not valid'))).toBe(true)
    expect(logs.join('\n')).not.toContain(hashLike)
    expect(existsSync(secretFile())).toBe(false)
  })

  test('update saves the setting and opens, keeps, moves or closes the tunnel to match', () => {
    setup()
    service.update({ enabled: true, serverUrl: 'ws://127.0.0.1:4600', clientUrl: null })
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toEqual({
      enabled: true,
      serverUrl: 'ws://127.0.0.1:4600',
      clientUrl: null,
    })
    expect(tunnels).toHaveLength(1)

    service.update({ enabled: true, serverUrl: 'ws://127.0.0.1:4600', clientUrl: 'https://orch.example' })
    expect(tunnels).toHaveLength(1)

    const moved = service.update({ enabled: true, serverUrl: 'ws://localhost:4700', clientUrl: null })
    expect(tunnels.map((t) => [t.options.url, t.status])).toEqual([
      ['ws://127.0.0.1:4600/tunnel', 'off'],
      ['ws://localhost:4700/tunnel', 'connecting'],
    ])
    expect(moved).toMatchObject({ enabled: true, serverUrl: 'ws://localhost:4700', tunnel: 'connecting' })

    const off = service.update({ enabled: false, serverUrl: 'ws://localhost:4700', clientUrl: null })
    expect(tunnels[1]?.status).toBe('off')
    expect(off).toMatchObject({ enabled: false, tunnel: 'off' })
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toMatchObject({ enabled: false })
  })

  test('an address the host refuses gets a 400, and nothing is saved or changed', async () => {
    const saved = { enabled: true, serverUrl: 'ws://127.0.0.1:4600', clientUrl: null }
    const app = setup(saved)
    const before = readFileSync(settingsFile(), 'utf8')
    for (const body of [
      { enabled: true, serverUrl: 'ws://example.com', clientUrl: null },
      { enabled: true, serverUrl: 'https://x', clientUrl: null },
      { enabled: false, serverUrl: 'ws://127.0.0.1:4600', clientUrl: 'ftp://x' },
      { enabled: true, serverUrl: '', clientUrl: null },
    ]) {
      const response = await app.request(routes.remoteAccess.update.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before)
    expect(tunnels.map((t) => t.status)).toEqual(['connecting'])
  })

  test('rotate follows the setting: 409 without a server address, then a link on the saved or derived client address', async () => {
    const app = setup()
    const rotate = () => app.request(routes.access.rotate.path, { method: 'POST' })
    expect((await rotate()).status).toBe(409)

    service.update({ enabled: true, serverUrl: 'ws://127.0.0.1:4600', clientUrl: null })
    const revoked = storedKeys().map((k) => k.id)
    const derived = (await (await rotate()).json()) as RotateAccessResponse
    expect(derived.link).toBe(`http://127.0.0.1:4600/#machine=${derived.machineId}&key=${derived.key}`)
    expect(tunnels[0]?.closed).toEqual([revoked])

    service.update({ enabled: true, serverUrl: 'ws://127.0.0.1:4600', clientUrl: 'https://orch.example' })
    const saved = (await (await rotate()).json()) as RotateAccessResponse
    expect(saved.link).toBe(`https://orch.example/#machine=${saved.machineId}&key=${saved.key}`)
  })
})
