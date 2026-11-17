import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LinkedAccount, RemoteAccessStatus } from '@orch/shared'
import { linkedAccountPath } from '../modules/remote-access/linked-account.repository'
import { remoteAccessPath } from '../modules/remote-access/remote-access.repository'
import { settingsPath } from '../modules/settings/settings.repository'
import type { CallHost } from '../remote-cli'
import type { ConfigAction } from './args'
import { runConfig } from './config'

let dir: string
const config = () => settingsPath(dir)
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corch-config-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

interface Options {
  env?: Record<string, string>
  callHost?: CallHost | null
}

/** Runs one subcommand against the temporary folder, collecting what it prints. */
async function run(action: ConfigAction, { env = {}, callHost = null }: Options = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await runConfig(action, {
    dataDir: dir,
    env,
    callHost,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const set = (key: string, value: string): ConfigAction => ({ name: 'set', key, value })
const unset = (key: string): ConfigAction => ({ name: 'unset', key })

const account: LinkedAccount = {
  name: 'Ada',
  maskedEmail: 'a***@example.com',
  serverUrl: 'wss://old.example.com',
  linkedAt: '2026-11-04T12:00:00.000Z',
}

/** A running host, connected to `account` or not. It answers every call with its status. */
function fakeHost(linkedAccount: LinkedAccount | null): CallHost {
  const status: RemoteAccessStatus = {
    serverUrl: 'wss://old.example.com',
    serverUrlIsDefault: false,
    defaultServerUrl: 'wss://orch.example.com',
    serverUrlSetBy: null,
    machineId: null,
    machineFingerprint: null,
    tunnel: linkedAccount ? 'connected' : 'off',
    linkedAccount,
    connectRequest: null,
    connectOutcome: null,
  }
  return (async () => ({ ok: true, data: status })) as CallHost
}

const DISCONNECT_FIRST =
  'This machine is connected to an account through its server address. Run corch disconnect first.'

describe('corch config list, get and path', () => {
  test('list shows each value in effect and where it came from; get prints the value alone', async () => {
    writeFileSync(config(), JSON.stringify({ port: 4700, relayUrl: 'wss://relay.example.com' }))
    const env = { CORCH_LOG_LEVEL: 'debug' }
    const listed = await run({ name: 'list' }, { env })
    expect(listed.code).toBe(0)
    expect(listed.out.split('\n')).toEqual([
      'port      4700  (file)',
      'relayUrl  wss://relay.example.com  (file)',
      'logLevel  debug  (env CORCH_LOG_LEVEL)',
    ])
    expect((await run({ name: 'get', key: 'port' })).out).toBe('4700')
    expect((await run({ name: 'get', key: 'logLevel' }, { env })).out).toBe('debug')
  })

  test('path names config.json whether or not it exists', async () => {
    expect((await run({ name: 'path' })).out).toBe(join(dir, 'config.json'))
    expect(existsSync(config())).toBe(false)
  })

  test('an unknown key or a config.json that is not valid exits 1 with the settings message', async () => {
    for (const action of [{ name: 'get', key: 'colour' } as const, set('clientUrl', 'https://x'), unset('clientUrl')]) {
      const unknown = await run(action)
      const key = 'key' in action ? action.key : ''
      expect([unknown.code, unknown.err]).toEqual([
        1,
        `${key} is not a setting. The settings are port, relayUrl, logLevel`,
      ])
    }
    expect(existsSync(config())).toBe(false)
    writeFileSync(config(), '{ "port": ')
    const broken = await run({ name: 'list' })
    expect([broken.code, broken.err]).toEqual([
      1,
      `${config()} is not valid JSON. Fix the file, or delete it to use the defaults`,
    ])
  })
})

describe('corch config set and unset', () => {
  test('set saves a checked value and keeps the other keys; unset removes only its key', async () => {
    writeFileSync(config(), JSON.stringify({ logLevel: 'warn', relayUrl: 'wss://relay.example.com' }))
    const saved = await run(set('port', '5000'))
    expect(saved.code).toBe(0)
    expect(readJson(config())).toEqual({ logLevel: 'warn', relayUrl: 'wss://relay.example.com', port: 5000 })
    // No host runs, so there is nothing to restart.
    expect(saved.out).not.toContain('restart')

    expect((await run(unset('logLevel'))).code).toBe(0)
    expect(readJson(config())).toEqual({ relayUrl: 'wss://relay.example.com', port: 5000 })
  })

  test('a clientUrl older hosts saved is ignored, and the next set drops it from the file', async () => {
    writeFileSync(config(), JSON.stringify({ clientUrl: 'https://app.example.com', port: 5000 }))
    const listed = await run({ name: 'list' })
    expect(listed.code).toBe(0)
    expect(listed.out).toContain('port      5000  (file)')
    expect(listed.out).not.toContain('clientUrl')

    expect((await run(set('logLevel', 'warn'))).code).toBe(0)
    expect(readJson(config())).toEqual({ port: 5000, logLevel: 'warn' })
  })

  test('a bad value, an unknown key or a config.json that is not valid leaves the file as it was', async () => {
    const before = '{"logLevel":"warn"}'
    writeFileSync(config(), before)
    const port = await run(set('port', '70000'))
    expect([port.code, port.err]).toEqual([1, 'port must be a whole number from 1 to 65535'])
    expect((await run(set('relayUrl', 'http://relay.example.com'))).code).toBe(1)
    expect((await run(set('colour', 'red'))).code).toBe(1)
    expect((await run(unset('colour'))).code).toBe(1)
    expect(readFileSync(config(), 'utf8')).toBe(before)

    const bad = '{"logLevel":"loud"}'
    writeFileSync(config(), bad)
    const refused = await run(set('port', '5000'))
    expect([refused.code, refused.err]).toEqual([1, 'config.json: logLevel must be one of error, warn, info, debug'])
    expect((await run(unset('logLevel'))).code).toBe(1)
    expect(readFileSync(config(), 'utf8')).toBe(bad)
  })

  test('saves even when a CORCH_ variable sets the key, and says it overrides the file', async () => {
    const saved = await run(set('port', '5000'), { env: { CORCH_PORT: '6000' } })
    expect(saved.code).toBe(0)
    expect(readJson(config())).toEqual({ port: 5000 })
    expect(saved.out).toContain('CORCH_PORT is set in this shell and overrides it')
  })

  test('with the host stopped, migrates the old remote-access addresses first', async () => {
    const old = { enabled: true, serverUrl: 'wss://relay.example.com', clientUrl: 'https://app.example.com' }
    writeFileSync(remoteAccessPath(dir), JSON.stringify(old))
    expect((await run(set('port', '5000'))).code).toBe(0)
    expect(readJson(config())).toEqual({ relayUrl: 'wss://relay.example.com', port: 5000 })
    expect(readJson(remoteAccessPath(dir))).toEqual({ enabled: true })
  })

  test('refuses to change relayUrl while linked-account.json connects the machine, and other keys still change', async () => {
    writeFileSync(config(), JSON.stringify({ relayUrl: 'wss://old.example.com' }))
    writeFileSync(linkedAccountPath(dir), JSON.stringify(account))
    for (const action of [set('relayUrl', 'wss://new.example.com'), unset('relayUrl')]) {
      expect(await run(action)).toMatchObject({ code: 1, err: DISCONNECT_FIRST })
    }
    expect((await run(set('port', '5000'))).code).toBe(0)
    expect(readJson(config())).toEqual({ relayUrl: 'wss://old.example.com', port: 5000 })

    writeFileSync(linkedAccountPath(dir), 'not json')
    const broken = await run(set('relayUrl', 'wss://new.example.com'))
    expect([broken.code, broken.err]).toEqual([1, expect.stringContaining('linked-account.json is not valid')])
  })
})

describe('corch config with a running host', () => {
  test('says the change applies after a restart, and refuses relayUrl while the host is connected', async () => {
    const saved = await run(set('relayUrl', 'wss://new.example.com'), { callHost: fakeHost(null) })
    expect(saved.out).toContain('The running host uses the change after corch restart.')
    expect(readJson(config())).toEqual({ relayUrl: 'wss://new.example.com' })

    // The running host decides, whatever the file says.
    writeFileSync(linkedAccountPath(dir), JSON.stringify(account))
    expect((await run(unset('relayUrl'), { callHost: fakeHost(null) })).code).toBe(0)
    const refused = await run(set('relayUrl', 'wss://other.example.com'), { callHost: fakeHost(account) })
    expect(refused).toMatchObject({ code: 1, err: DISCONNECT_FIRST })
    expect(readJson(config())).toEqual({})
  })
})
