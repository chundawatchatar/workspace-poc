import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { type RotateAccessResponse, routes } from '@orch/shared'
import { fingerprintOf } from './device-proof.service'
import { DEFAULT_SERVER_URL, hostMachineName, linkClientUrl } from './remote-access.service'
import {
  account,
  accountId,
  connected,
  dir,
  expiresAt,
  type FakeTunnel,
  key,
  linkedFile,
  logs,
  post,
  relay,
  relayKeys,
  secretFile,
  service,
  settingsFile,
  setup,
  storedKeys,
  tunnels,
  useRemoteAccessHarness,
} from './remote-access.testing'

useRemoteAccessHarness()

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
    expect(linkClientUrl({}, null)).toBe('https://orch.example.com')
  })

  test('a missing or invalid setting file leaves remote access off, and an invalid one is logged and kept', () => {
    setup()
    expect(tunnels).toHaveLength(0)
    expect(service.status()).toMatchObject({
      enabled: false,
      serverUrl: DEFAULT_SERVER_URL,
      serverUrlIsDefault: true,
      machineId: null,
      tunnel: 'off',
      linkedAccount: null,
    })
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

  test('rotate follows the setting: a link on the default, then on the saved or derived client address', async () => {
    const app = setup()
    const rotate = () => app.request(routes.access.rotate.path, { method: 'POST' })
    const fallback = (await (await rotate()).json()) as RotateAccessResponse
    expect(fallback.link).toStartWith('https://orch.example.com/#machine=')

    service.update({ enabled: true, serverUrl: 'ws://127.0.0.1:4600', clientUrl: null })
    const revoked = storedKeys().map((k) => k.id)
    const derived = (await (await rotate()).json()) as RotateAccessResponse
    expect(derived.link).toBe(`http://127.0.0.1:4600/#machine=${derived.machineId}&key=${derived.key}`)
    const [closed] = tunnels[0]?.closed ?? []
    expect(closed?.reason).toBe('key rotated')
    expect(revoked.every((keyId) => closed?.revoked({ kind: 'key', keyId, name: 'default', deviceId: 'd1' }))).toBe(
      true,
    )
    // Account sockets stay open across a rotation.
    expect(closed?.revoked({ kind: 'account', accountId, deviceId: 'd1' })).toBe(false)

    service.update({ enabled: true, serverUrl: 'ws://127.0.0.1:4600', clientUrl: 'https://orch.example' })
    const saved = (await (await rotate()).json()) as RotateAccessResponse
    expect(saved.link).toBe(`https://orch.example/#machine=${saved.machineId}&key=${saved.key}`)
  })

  test('the default address is used when none is set, and only it counts as the default', () => {
    setup()
    service.update({ enabled: true, serverUrl: '', clientUrl: null })
    expect(tunnels.map((t) => t.options.url)).toEqual(['wss://orch.example.com/tunnel'])
    expect(service.status()).toMatchObject({ serverUrl: DEFAULT_SERVER_URL, serverUrlIsDefault: true })

    service.update({ enabled: true, serverUrl: 'wss://orch.example.com/', clientUrl: null })
    expect(service.status().serverUrlIsDefault).toBe(true)
    service.update({ enabled: true, serverUrl: 'ws://127.0.0.1:4600', clientUrl: null })
    expect(service.status()).toMatchObject({ serverUrl: 'ws://127.0.0.1:4600', serverUrlIsDefault: false })
    service.shutdown()

    setup(undefined, { SERVER_URL: 'wss://relay.example.com' })
    expect(service.status()).toMatchObject({ serverUrl: 'wss://relay.example.com', serverUrlIsDefault: false })
  })

  test('preview shows the key, link saves the account after the user confirms, and unlink forgets it', async () => {
    const { app, tunnel } = connected()
    const machineId = service.status().machineId
    tunnel.answer = (request) =>
      request.type === 'enroll.preview'
        ? { type: 'enroll.previewed', id: 1, account, fingerprint: 'kkkk', expiresAt }
        : { type: 'enroll.redeemed', id: 2, machineId: machineId ?? '', accountId, account, relayKeys }
    const files = readdirSync(dir).sort()

    const preview = await post(app, routes.remoteAccess.previewLink, { key })
    expect(preview.json()).toEqual({
      serverUrl: 'ws://127.0.0.1:4600',
      serverUrlIsDefault: false,
      account,
      fingerprint: 'kkkk',
      expiresAt,
    })
    expect(tunnel.sent).toEqual([{ type: 'enroll.preview', key }])
    expect(readdirSync(dir).sort()).toEqual(files)

    // A malformed key, or an address other than the one in use, never reaches the tunnel.
    expect((await post(app, routes.remoteAccess.previewLink, { key: 'oek_short' })).status).toBe(400)
    const elsewhere = await post(app, routes.remoteAccess.link, { key, serverUrl: 'wss://evil.example.com' })
    expect(elsewhere.status).toBe(409)
    expect(tunnel.sent).toHaveLength(1)

    const linked = await post(app, routes.remoteAccess.link, { key, serverUrl: 'ws://127.0.0.1:4600' })
    expect(tunnel.sent[1]).toEqual({ type: 'enroll.redeem', key, name: hostMachineName() })
    const { accountId: savedId, relayKeys: savedKeys, ...saved } = JSON.parse(readFileSync(linkedFile(), 'utf8'))
    expect([savedId, savedKeys]).toEqual([accountId, relayKeys])
    expect(saved).toEqual({ ...account, serverUrl: 'ws://127.0.0.1:4600', linkedAt: expect.any(String) })
    // The account id and the keys stay on this machine: the status, and so the page, never shows them.
    expect(linked.json().linkedAccount).toEqual(saved)
    expect(linked.text).not.toContain(accountId)
    expect(linked.text).not.toContain(relay.relayKey.publicKey)
    expect(readFileSync(linkedFile(), 'utf8')).not.toContain(key)

    const again = await post(app, routes.remoteAccess.previewLink, { key })
    expect(again).toMatchObject({ status: 409, text: 'Unlink first' })
    expect(tunnel.sent).toHaveLength(2)

    // The account survives a restart.
    service.shutdown()
    const restarted = setup()
    expect(service.status().linkedAccount).toEqual(saved)

    const unlinked = await post(restarted, routes.remoteAccess.unlink, {})
    expect(unlinked.json().linkedAccount).toBeNull()
    expect(existsSync(linkedFile())).toBe(false)
    expect(logs.join('\n')).not.toContain(key)
  })

  test('link failures answer with their own status and save nothing', async () => {
    const { app, tunnel } = connected()
    const failed = (code: 'invalid_key' | 'rate_limited' | 'unavailable') => () => ({
      type: 'enroll.failed' as const,
      id: 1,
      code,
    })
    const cases: [FakeTunnel['answer'], number, string?][] = [
      [failed('invalid_key'), 400, 'This key is unknown, used or expired'],
      [failed('rate_limited'), 429],
      [failed('unavailable'), 503],
      [
        () => {
          throw new Error('the tunnel closed')
        },
        503,
      ],
      // A link to another machine id than this host's.
      [() => ({ type: 'enroll.redeemed', id: 1, machineId: 'someone-else', accountId, account, relayKeys }), 502],
    ]
    for (const [answer, status, message] of cases) {
      tunnel.answer = answer
      const link = await post(app, routes.remoteAccess.link, { key, serverUrl: 'ws://127.0.0.1:4600' })
      expect(link.status).toBe(status)
      if (message) expect(link.text).toBe(message)
      if (status === 502) continue
      const preview = await post(app, routes.remoteAccess.previewLink, { key })
      expect(preview.status).toBe(status)
    }
    expect(existsSync(linkedFile())).toBe(false)
    expect(service.status().linkedAccount).toBeNull()

    tunnel.status = 'reconnecting'
    const offline = await post(app, routes.remoteAccess.previewLink, { key })
    expect(offline).toMatchObject({ status: 409, text: 'Turn remote access on and wait until it is connected' })
    expect(tunnel.sent).toHaveLength(9)
  })
})

describe('remote sessions', () => {
  /** Device ids that differ in their first character, so each has its own fingerprint. */
  const deviceId = (n: number) => `${n}${'d'.repeat(42)}`

  test('listSessions groups channels per device, newest first, and endSession closes one device with 4401', async () => {
    const off = setup()
    expect(await (await off.request(routes.remoteAccess.sessions.path)).json()).toEqual({ sessions: [] })

    const { app, tunnel } = connected()
    const [a, b] = [deviceId(1), deviceId(2)]
    tunnel.channels = [
      { principal: { kind: 'account', accountId, deviceId: a }, openedAt: Date.UTC(2026, 10, 6, 12, 0) },
      { principal: { kind: 'key', keyId: 'k1', name: 'laptop', deviceId: a }, openedAt: Date.UTC(2026, 10, 6, 11, 0) },
      { principal: { kind: 'account', accountId, deviceId: a }, openedAt: Date.UTC(2026, 10, 6, 13, 0) },
      { principal: { kind: 'key', keyId: 'k2', name: 'phone', deviceId: b }, openedAt: Date.UTC(2026, 10, 6, 12, 30) },
    ]
    const listed = await app.request(routes.remoteAccess.sessions.path)
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

describe('hostMachineName', () => {
  test('trims the host name, cuts it to 64 characters, and falls back to this machine', () => {
    expect(hostMachineName('  box.local \n')).toBe('box.local')
    expect(hostMachineName('x'.repeat(80))).toBe('x'.repeat(64))
    expect(hostMachineName('   ')).toBe('this machine')
  })
})
