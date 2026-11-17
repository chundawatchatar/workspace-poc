import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { machineFingerprint, type RotateAccessResponse, routes, startBrowserHandshake } from '@orch/shared'
import { localRequest } from '../../app.testing'
import type { Principal } from '../../lib/principal'
import { loadSettings } from '../settings/settings.service'
import { devAddresses, linkClientUrl } from './addresses.service'
import { fingerprintOf } from './device-proof.service'
import { testDevice } from './device-proof.testing'
import { DevicesRepository } from './devices.repository'
import { DEFAULT_SERVER_URL, hostMachineName } from './remote-access.service'
import {
  account,
  accountId,
  configFile,
  connected,
  devicesFile,
  dir,
  e2eSessions,
  email,
  type FakeTunnel,
  fakeServer,
  key,
  linkedFile,
  logs,
  machineKeyFile,
  post,
  relay,
  relayKeys,
  savedAccount,
  service,
  setup,
  storedKeys,
  tunnels,
  useRemoteAccessHarness,
} from './remote-access.testing'

useRemoteAccessHarness()

/** A device id that differs from the others in its first character, so each has its own fingerprint. */
const deviceOf = (n: number) => `${n}${'d'.repeat(42)}`
const publicKey = { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) } as const

/** Saves one approved device, as a browser approved for an earlier account would have left it. */
function approvedEarlier() {
  new DevicesRepository(devicesFile()).save([{ id: deviceOf(1), publicKey, approvedAt: new Date().toISOString() }])
}

describe('RemoteAccessService', () => {
  test('a saved account opens one tunnel at start and creates the default key; without one nothing opens', async () => {
    writeFileSync(join(dir, 'remote-access.json'), JSON.stringify({ enabled: true }))
    const app = setup({ serverUrl: 'ws://127.0.0.1:4600' }, { SERVER_URL: 'ws://127.0.0.1:4600' })
    expect(tunnels).toHaveLength(0)
    expect(service.status()).toMatchObject({
      serverUrl: 'ws://127.0.0.1:4600',
      serverUrlSetBy: 'SERVER_URL',
      defaultServerUrl: DEFAULT_SERVER_URL,
      machineId: null,
      tunnel: 'off',
      linkedAccount: null,
    })
    // With no machine key yet, the key route answers 404 and never creates one.
    expect((await localRequest(app, routes.system.machineKey.path)).status).toBe(404)
    expect(existsSync(machineKeyFile())).toBe(false)
    service.shutdown()

    setup({ linked: true, serverUrl: 'ws://127.0.0.1:4600' })
    expect(tunnels.map((t) => t.options.url)).toEqual(['ws://127.0.0.1:4600/tunnel'])
    expect(storedKeys().map((k) => k.name)).toEqual(['default'])
    const { machineId } = service.status()
    const printed = `Connect link: http://127.0.0.1:4600/#machine=${machineId}&key=`
    const link = logs.find((line) => line.includes(printed))
    expect(link).toEndWith(`&fp=${machineFingerprint(String(machineId))}`)
    expect(service.status()).toMatchObject({
      tunnel: 'connecting',
      linkedAccount: { ...account, serverUrl: 'ws://127.0.0.1:4600' },
    })
  })

  test('SERVER_URL and CLIENT_URL override the saved addresses', () => {
    const env = { SERVER_URL: 'wss://relay.example.com', CLIENT_URL: 'https://env.example/' }
    setup({ linked: true, serverUrl: 'ws://127.0.0.1:4600', clientUrl: 'https://saved.example' }, env)
    expect(tunnels.map((t) => t.options.url)).toEqual(['wss://relay.example.com/tunnel'])
    expect(service.status()).toMatchObject({
      serverUrl: 'wss://relay.example.com',
      clientUrl: 'https://env.example/',
      serverUrlSetBy: 'SERVER_URL',
      clientUrlSetBy: 'CLIENT_URL',
    })
    expect(service.current()?.clientUrl).toBe('https://env.example')

    // The link falls back from `CLIENT_URL` to the saved client address, then to the server address in use.
    const link = (file: unknown, env: Record<string, string> = {}) =>
      linkClientUrl(devAddresses(loadSettings({ flags: {}, env: {}, file }), env, () => {}).clientUrl)
    expect(link({ relayUrl: 'ws://127.0.0.1:4600', clientUrl: 'https://saved.example' })).toBe('https://saved.example')
    expect(link({ relayUrl: 'ws://127.0.0.1:4600' }, { CLIENT_URL: 'ftp://nope' })).toBe('http://127.0.0.1:4600')
    expect(link({ relayUrl: 'ws://127.0.0.1:4600' }, { SERVER_URL: 'wss://relay.example.com' })).toBe(
      'https://relay.example.com',
    )
    expect(link(null)).toBe('https://orch.example.com')
  })

  test('a linked account file that is not valid leaves the machine not connected, logged and kept', () => {
    const hashLike = 'h'.repeat(43)
    const invalid = `{"name": "Ada", "accountId": "${hashLike}"`
    setup(invalid)
    expect(tunnels).toHaveLength(0)
    expect(service.status()).toMatchObject({ tunnel: 'off', linkedAccount: null })
    expect(readFileSync(linkedFile(), 'utf8')).toBe(invalid)
    expect(logs.some((line) => line.includes('linked-account.json is not valid'))).toBe(true)
    expect(logs.join('\n')).not.toContain(hashLike)
    expect(existsSync(machineKeyFile())).toBe(false)
  })

  test('connect saves the address, clears the devices, opens the tunnel at once and saves the account', async () => {
    approvedEarlier()
    const app = setup()
    // Written while the host runs: connect rereads the file, so this key survives.
    writeFileSync(configFile(), JSON.stringify({ logLevel: 'debug' }))
    expect(service.listDevices().approved).toHaveLength(1)

    const answer = await post(app, routes.remoteAccess.connect, {
      email: ` ${email} `,
      key,
      serverUrl: 'ws://localhost:4700',
    })
    expect(answer.status).toBe(200)
    expect(JSON.parse(readFileSync(configFile(), 'utf8'))).toEqual({
      logLevel: 'debug',
      relayUrl: 'ws://localhost:4700',
    })
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(service.listDevices()).toEqual({ pending: [], approved: [] })
    expect(tunnels.map((t) => [t.options.url, t.status])).toEqual([['ws://localhost:4700/tunnel', 'connected']])
    expect(tunnels[0]?.sent).toEqual([{ type: 'enroll.redeem', key, email, name: hostMachineName() }])

    const { accountId: savedId, relayKeys: savedKeys, ...saved } = JSON.parse(readFileSync(linkedFile(), 'utf8'))
    expect([savedId, savedKeys]).toEqual([accountId, relayKeys])
    expect(saved).toEqual({ ...account, serverUrl: 'ws://localhost:4700', linkedAt: expect.any(String) })
    // The account id and the keys stay on this machine: the status, and so the page, never shows them.
    expect(answer.json()).toMatchObject({
      serverUrl: 'ws://localhost:4700',
      serverUrlIsDefault: false,
      tunnel: 'connected',
      linkedAccount: saved,
    })
    for (const hidden of [accountId, relay.relayKey.publicKey, key, email]) expect(answer.text).not.toContain(hidden)
    expect(readFileSync(linkedFile(), 'utf8')).not.toContain(key)
    expect(logs.join('\n')).not.toContain(key)
    expect(logs.join('\n')).not.toContain(email)

    // A connected machine refuses another connect, and the account survives a restart.
    const again = await post(app, routes.remoteAccess.connect, { email, key, serverUrl: 'ws://localhost:4700' })
    expect(again).toMatchObject({ status: 409, text: 'This machine is already connected. Disconnect it first' })
    service.shutdown()
    setup()
    expect(service.status()).toMatchObject({ serverUrl: 'ws://localhost:4700', linkedAccount: saved })
    expect(tunnels.at(-1)?.options.url).toBe('ws://localhost:4700/tunnel')
  })

  test('connect to the default saves no address, and only the default counts as it', async () => {
    writeFileSync(configFile(), JSON.stringify({ relayUrl: 'ws://127.0.0.1:4600' }))
    const app = setup()
    expect(service.status()).toMatchObject({ serverUrl: 'ws://127.0.0.1:4600', serverUrlIsDefault: false })
    const answer = await post(app, routes.remoteAccess.connect, { email, key, serverUrl: `${DEFAULT_SERVER_URL}/` })
    expect(answer.json()).toMatchObject({ serverUrl: DEFAULT_SERVER_URL, serverUrlIsDefault: true })
    expect(JSON.parse(readFileSync(configFile(), 'utf8'))).toEqual({})
    expect(tunnels.map((t) => t.options.url)).toEqual(['wss://orch.example.com/tunnel'])
  })

  test('connect refuses a bad address, email or key, and another address than the one a variable sets', async () => {
    const app = setup(undefined, { SERVER_URL: 'wss://relay.example.com' })
    const secrets = ['oek_secret-but-short', 'secret-mail@', 'wss://evil.example.com', 'ws://evil.example.com']
    const cases: [unknown, number][] = [
      [{ email, key: secrets[0], serverUrl: 'wss://relay.example.com' }, 400],
      [{ email: secrets[1], key, serverUrl: 'wss://relay.example.com' }, 400],
      [{ email, key, serverUrl: secrets[3] }, 400],
      [{ email, key, serverUrl: '' }, 400],
      [{ email, key, serverUrl: 'wss://relay.example.com', machineId: 'm-2' }, 400],
      [{ email, key, serverUrl: secrets[2] }, 409],
    ]
    for (const [body, status] of cases) {
      const answer = await post(app, routes.remoteAccess.connect, body)
      expect([answer.status, secrets.filter((secret) => answer.text.includes(secret))]).toEqual([status, []])
      expect(answer.text).not.toContain(email)
    }
    expect(tunnels).toHaveLength(0)
    expect(existsSync(configFile())).toBe(false)

    const allowed = await post(app, routes.remoteAccess.connect, { email, key, serverUrl: 'wss://relay.example.com/' })
    expect(allowed.json()).toMatchObject({ serverUrl: 'wss://relay.example.com', serverUrlSetBy: 'SERVER_URL' })
    expect(existsSync(configFile())).toBe(false)
  })

  test('a failed connect links nothing, stops the tunnel and never echoes the key or the email', async () => {
    const app = setup()
    const failed = (code: 'invalid_key' | 'rate_limited' | 'unavailable') => () =>
      ({ type: 'enroll.failed', id: 1, code }) as const
    const lost = () => {
      throw new Error(`the tunnel closed ${key} ${email}`)
    }
    const cases: [Partial<typeof fakeServer>, number, string?][] = [
      [{ redeem: failed('invalid_key') }, 400, "This key is unknown, used or expired, or the email doesn't match"],
      [{ redeem: failed('rate_limited') }, 429],
      [{ redeem: failed('unavailable') }, 503],
      [{ redeem: lost }, 503, 'The server did not answer'],
      [{ reachable: false }, 503, 'Could not connect to the server'],
      // A link to another machine id than this host's.
      [{ redeem: () => ({ type: 'enroll.redeemed', id: 1, machineId: 'else', accountId, account, relayKeys }) }, 502],
    ]
    const defaults = { ...fakeServer }
    for (const [server, status, message] of cases) {
      Object.assign(fakeServer, defaults, server)
      const answer = await post(app, routes.remoteAccess.connect, { email, key, serverUrl: 'ws://127.0.0.1:4600' })
      expect(answer.status).toBe(status)
      if (message) expect(answer.text).toStartWith(message)
      expect(answer.text).not.toContain(key)
      expect(answer.text).not.toContain(email)
      expect(tunnels.at(-1)?.status).toBe('off')
      expect(service.status()).toMatchObject({ tunnel: 'off', linkedAccount: null })
    }
    expect(tunnels).toHaveLength(cases.length)
    expect(existsSync(linkedFile())).toBe(false)
    expect(logs.join('\n')).not.toContain(key)
  })

  test('disconnect asks the server to remove the machine, then forgets the account and stops the tunnel', async () => {
    approvedEarlier()
    const { app, tunnel } = connected()
    expect(service.listDevices().approved).toHaveLength(1)
    tunnel.channels = [
      { principal: { kind: 'account', accountId, deviceId: deviceOf(1), ticketExp: 0 }, openedAt: 1 },
      { principal: { kind: 'key', keyId: 'k1', name: 'laptop', deviceId: deviceOf(2) }, openedAt: 1 },
    ]
    const answer = await post(app, routes.remoteAccess.disconnect, {})
    expect(answer.json()).toMatchObject({ removedFromAccount: true, status: { tunnel: 'off', linkedAccount: null } })
    expect(tunnel.sent).toEqual([{ type: 'unlink', accountId }])
    expect(tunnel.closed.map(({ reason }) => reason)).toEqual(['disconnected'])
    expect(tunnel.channels.map((channel) => channel.principal.kind)).toEqual(['key'])
    expect(tunnel.stops).toEqual([{ remoteOff: true }])
    expect(existsSync(linkedFile())).toBe(false)
    expect(existsSync(devicesFile())).toBe(false)

    // Not connected: nothing is sent or changed.
    const idle = await post(app, routes.remoteAccess.disconnect, {})
    expect(idle.json()).toMatchObject({ removedFromAccount: false, status: { linkedAccount: null } })
    expect(tunnel.sent).toHaveLength(1)
  })

  test('disconnect forgets the account even when the server did not remove the machine', async () => {
    const failures: [string, () => void][] = [
      ['unlink.failed', () => (fakeServer.unlink = () => ({ type: 'unlink.failed', id: 1, code: 'unavailable' }))],
      [
        'no answer',
        () =>
          (fakeServer.unlink = () => {
            throw new Error('the server did not answer')
          }),
      ],
      ['tunnel down', () => (tunnels[0] as FakeTunnel).stop()],
      ['old file', () => writeFileSync(linkedFile(), JSON.stringify({ ...savedAccount('x'), accountId: undefined }))],
    ]
    for (const [name, fail] of failures) {
      if (name === 'old file') {
        fail()
        setup()
      } else {
        connected()
        fail()
      }
      const { removedFromAccount, status } = await service.disconnect()
      expect([name, removedFromAccount, status.linkedAccount]).toEqual([name, false, null])
      expect(existsSync(linkedFile())).toBe(false)
      expect(tunnels.at(-1)?.status).toBe('off')
      service.shutdown()
      tunnels.length = 0
    }
  })

  test('shutdown stops the tunnel without telling the server the machine disconnected', () => {
    const { tunnel } = connected()
    service.shutdown()
    expect(tunnel.stops).toEqual([undefined])
  })

  test('rotate follows the addresses in use: a link on the default, then on the saved or derived client address', async () => {
    const rotate = (app: ReturnType<typeof setup>) => localRequest(app, routes.access.rotate.path, { method: 'POST' })
    const fallback = (await (await rotate(setup())).json()) as RotateAccessResponse
    expect(fallback.link).toStartWith('https://orch.example.com/#machine=')
    service.shutdown()

    const onLoopback = setup({ linked: true, serverUrl: 'ws://127.0.0.1:4600' })
    const revoked = storedKeys().map((k) => k.id)
    const derived = (await (await rotate(onLoopback)).json()) as RotateAccessResponse
    expect(derived.link).toBe(
      `http://127.0.0.1:4600/#machine=${derived.machineId}&key=${derived.key}&fp=${machineFingerprint(derived.machineId)}`,
    )
    const [closed] = tunnels[0]?.closed ?? []
    expect(closed?.reason).toBe('key rotated')
    expect(revoked.every((keyId) => closed?.revoked({ kind: 'key', keyId, name: 'default', deviceId: 'd1' }))).toBe(
      true,
    )
    // Account sockets stay open across a rotation.
    expect(closed?.revoked({ kind: 'account', accountId, deviceId: 'd1', ticketExp: 0 })).toBe(false)
    service.shutdown()

    const withClient = setup({ linked: true, serverUrl: 'ws://127.0.0.1:4600', clientUrl: 'https://orch.example' })
    const saved = (await (await rotate(withClient)).json()) as RotateAccessResponse
    expect(saved.link).toBe(
      `https://orch.example/#machine=${saved.machineId}&key=${saved.key}&fp=${machineFingerprint(saved.machineId)}`,
    )
  })
})

describe('remote sessions', () => {
  /** Device ids that differ in their first character, so each has its own fingerprint. */
  const deviceId = (n: number) => `${n}${'d'.repeat(42)}`

  test('listSessions groups channels per device, newest first, and endSession closes one device with 4401', async () => {
    const off = setup()
    expect(await (await localRequest(off, routes.remoteAccess.sessions.path)).json()).toEqual({ sessions: [] })

    const { app, tunnel } = connected()
    const [a, b] = [deviceId(1), deviceId(2)]
    tunnel.channels = [
      { principal: { kind: 'account', accountId, deviceId: a, ticketExp: 0 }, openedAt: Date.UTC(2026, 10, 6, 12, 0) },
      { principal: { kind: 'key', keyId: 'k1', name: 'laptop', deviceId: a }, openedAt: Date.UTC(2026, 10, 6, 11, 0) },
      { principal: { kind: 'account', accountId, deviceId: a, ticketExp: 0 }, openedAt: Date.UTC(2026, 10, 6, 13, 0) },
      { principal: { kind: 'key', keyId: 'k2', name: 'phone', deviceId: b }, openedAt: Date.UTC(2026, 10, 6, 12, 30) },
    ]
    const listed = await localRequest(app, routes.remoteAccess.sessions.path)
    const text = await listed.text()
    expect(JSON.parse(text)).toEqual({
      sessions: [
        {
          deviceId: b,
          fingerprint: fingerprintOf(b),
          credentials: [{ kind: 'key', name: 'phone' }],
          sockets: 1,
          startedAt: '2026-11-06T12:30:00.000Z',
        },
        {
          deviceId: a,
          fingerprint: fingerprintOf(a),
          credentials: [{ kind: 'account' }, { kind: 'key', name: 'laptop' }],
          sockets: 3,
          startedAt: '2026-11-06T11:00:00.000Z',
        },
      ],
    })
    for (const hidden of ['k1', 'k2', accountId]) expect(text).not.toContain(hidden)

    const ended = await post(app, routes.remoteAccess.endSession, { id: a })
    expect(ended.json().sessions.map((session: { deviceId: string }) => session.deviceId)).toEqual([b])
    // No code means `CLOSE_ACCESS_DENIED`, the tunnel's default.
    expect(tunnel.closed.map(({ reason, code }) => [reason, code])).toEqual([['session ended by owner', undefined]])

    const unknown = await post(app, routes.remoteAccess.endSession, { id: deviceId(3) })
    expect(unknown.json().sessions).toHaveLength(1)
    expect((await post(app, routes.remoteAccess.endSession, { id: 'nope' })).status).toBe(400)
  })
})

describe('end-to-end sessions', () => {
  test('each way access ends closes exactly the matching e2e sessions, like the sockets', async () => {
    const [one, two] = await Promise.all([testDevice(), testDevice()])
    const approvedAt = new Date().toISOString()
    new DevicesRepository(devicesFile()).save([{ id: one.id, publicKey: one.publicKey, approvedAt }])
    const { app, tunnel } = connected()
    const [defaultKey] = storedKeys()
    const ticketExp = Math.floor(Date.now() / 1000) + 60
    const principals: Record<string, [Principal, typeof one]> = {
      keyOne: [{ kind: 'key', keyId: defaultKey?.id ?? '', name: 'default', deviceId: one.id }, one],
      accountOne: [{ kind: 'account', accountId, deviceId: one.id, ticketExp }, one],
      accountTwo: [{ kind: 'account', accountId, deviceId: two.id, ticketExp }, two],
      keyTwo: [{ kind: 'key', keyId: 'k-other', name: 'phone', deviceId: two.id }, two],
      otherAccount: [{ kind: 'account', accountId: 'acct-bob-2', deviceId: two.id, ticketExp }, two],
    }
    const machineId = service.status().machineId ?? ''
    /** Opens one fresh session per principal, then runs `end`, and answers the names whose session it closed. */
    const closedBy = async (end: () => unknown) => {
      e2eSessions.closeAll()
      const opened: [string, string][] = []
      for (const [name, [principal, device]] of Object.entries(principals)) {
        const { hello } = await startBrowserHandshake({ machineId, device: device.signer })
        opened.push([name, (await e2eSessions.open(principal, hello)).sessionId])
      }
      await end()
      return opened.filter(([, id]) => e2eSessions.get(id) === null).map(([name]) => name)
    }

    expect(await closedBy(() => service.removeDevice(one.id))).toEqual(['keyOne', 'accountOne'])
    expect(await closedBy(() => service.endSession(two.id))).toEqual(['accountTwo', 'keyTwo', 'otherAccount'])
    expect(await closedBy(() => tunnel.options.onSessionEnded?.(accountId))).toEqual(['accountOne', 'accountTwo'])
    expect(await closedBy(() => post(app, routes.access.rotate, {}))).toEqual(['keyOne'])
    // Disconnecting closes the account's sessions, then every other one with the tunnel.
    expect(await closedBy(() => service.disconnect())).toEqual(Object.keys(principals))
  })
})

describe('hostMachineName', () => {
  test('trims the host name, cuts it to 64 characters, and falls back to this machine', () => {
    expect(hostMachineName('  box.local \n')).toBe('box.local')
    expect(hostMachineName('x'.repeat(80))).toBe('x'.repeat(64))
    expect(hostMachineName('   ')).toBe('this machine')
  })
})
