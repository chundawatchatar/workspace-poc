import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RemoteAccessStatus, routes, type UpdateRemoteAccessBody } from '@orch/shared'
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
  answer?: string | null
}

/** Runs one subcommand against the temporary folder, collecting what it prints and the questions it asks. */
async function run(action: ConfigAction, { env = {}, callHost = null, answer = null }: Options = {}) {
  const out: string[] = []
  const err: string[] = []
  const asked: string[] = []
  const code = await runConfig(action, {
    dataDir: dir,
    env,
    callHost,
    prompt: async (question) => {
      asked.push(question)
      return answer
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  return { code, out: out.join('\n'), err: err.join('\n'), asked }
}

const set = (key: string, value: string, yes = false): ConfigAction => ({ name: 'set', key, value, yes })
const unset = (key: string, yes = false): ConfigAction => ({ name: 'unset', key, yes })

/** A running host whose remote access is `enabled`, through `relay`. It records every `update` it gets. */
function fakeHost(enabled: boolean, relay = 'wss://old.example.com') {
  const updates: UpdateRemoteAccessBody[] = []
  let status: RemoteAccessStatus = {
    enabled,
    serverUrl: relay,
    serverUrlIsDefault: false,
    clientUrl: null,
    serverUrlSetBy: null,
    clientUrlSetBy: null,
    savedServerUrl: relay,
    savedClientUrl: null,
    restartNeeded: false,
    machineId: null,
    machineFingerprint: null,
    tunnel: enabled ? 'connected' : 'off',
    linkedAccount: null,
  }
  const callHost = (async (endpoint: unknown, input: unknown) => {
    if (endpoint === routes.remoteAccess.update) {
      const body = input as UpdateRemoteAccessBody
      updates.push(body)
      status = { ...status, enabled: body.enabled, tunnel: body.enabled ? 'connecting' : 'off' }
    }
    return { ok: true, data: status }
  }) as CallHost
  return { callHost, updates }
}

describe('corch config list, get and path', () => {
  test('list shows each value in effect and where it came from; get prints the value alone', async () => {
    writeFileSync(config(), JSON.stringify({ port: 4700, relayUrl: 'wss://relay.example.com' }))
    const env = { CORCH_LOG_LEVEL: 'debug' }
    const listed = await run({ name: 'list' }, { env })
    expect(listed.code).toBe(0)
    expect(listed.out.split('\n')).toEqual([
      'port       4700  (file)',
      'relayUrl   wss://relay.example.com  (file)',
      'clientUrl  https://relay.example.com  (derived)',
      'logLevel   debug  (env CORCH_LOG_LEVEL)',
    ])
    expect((await run({ name: 'get', key: 'port' })).out).toBe('4700')
    expect((await run({ name: 'get', key: 'logLevel' }, { env })).out).toBe('debug')
  })

  test('path names config.json whether or not it exists', async () => {
    expect((await run({ name: 'path' })).out).toBe(join(dir, 'config.json'))
    expect(existsSync(config())).toBe(false)
  })

  test('an unknown key or a config.json that is not valid exits 1 with the settings message', async () => {
    const unknown = await run({ name: 'get', key: 'colour' })
    expect([unknown.code, unknown.err]).toEqual([
      1,
      'colour is not a setting. The settings are port, relayUrl, clientUrl, logLevel',
    ])
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
    writeFileSync(config(), JSON.stringify({ logLevel: 'warn', clientUrl: 'https://app.example.com' }))
    const saved = await run(set('port', '5000'))
    expect(saved.code).toBe(0)
    expect(readJson(config())).toEqual({ logLevel: 'warn', clientUrl: 'https://app.example.com', port: 5000 })
    // No host runs, so there is nothing to restart.
    expect(saved.out).not.toContain('restart')

    expect((await run(unset('clientUrl'))).code).toBe(0)
    expect(readJson(config())).toEqual({ logLevel: 'warn', port: 5000 })
    expect((await run({ name: 'list' })).out).toContain('clientUrl  https://orch.example.com  (derived)')
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
    writeFileSync(remoteAccessPath(dir), JSON.stringify({ enabled: true, clientUrl: 'https://app.example.com' }))
    expect((await run(set('port', '5000'))).code).toBe(0)
    expect(readJson(config())).toEqual({ clientUrl: 'https://app.example.com', port: 5000 })
    expect(readJson(remoteAccessPath(dir))).toEqual({ enabled: true })
  })

  test('warns that a linked account belongs to the old server when the relay changes', async () => {
    const account = {
      name: 'Ada',
      maskedEmail: 'a***',
      serverUrl: 'wss://old.example.com',
      linkedAt: new Date().toISOString(),
    }
    writeFileSync(linkedAccountPath(dir), JSON.stringify(account))
    writeFileSync(config(), JSON.stringify({ relayUrl: 'wss://old.example.com' }))
    const changed = await run(set('relayUrl', 'wss://new.example.com'))
    expect(changed.out).toContain('linked to an account through wss://old.example.com')
    expect((await run(set('port', '5000'))).out).not.toContain('linked')
  })
})

describe('corch config with a running host', () => {
  test('says the change applies after a restart, and asks nothing when remote access is off', async () => {
    const host = fakeHost(false)
    const saved = await run(set('relayUrl', 'wss://new.example.com'), { callHost: host.callHost })
    expect(saved.out).toContain('The running host uses the change after corch restart.')
    expect(saved.asked).toEqual([])
    expect(host.updates).toEqual([])
  })

  test('offers to turn remote access off when the relay changes; any answer but y leaves it on', async () => {
    writeFileSync(config(), JSON.stringify({ relayUrl: 'wss://old.example.com', port: 4700 }))
    for (const answer of ['n', null]) {
      const host = fakeHost(true)
      const kept = await run(set('relayUrl', `wss://new-${answer}.example.com`), { callHost: host.callHost, answer })
      expect(kept.code).toBe(0)
      expect(kept.out).toContain('The open tunnel stays connected to wss://old.example.com until corch restart.')
      expect(kept.asked).toEqual(['Turn remote access off now? [y/N] '])
      expect(host.updates).toEqual([])
      expect(readJson(config()).relayUrl).toBe(`wss://new-${answer}.example.com`)
    }
  })

  test('y or --yes turns it off through the host, sending the newly saved addresses', async () => {
    writeFileSync(config(), JSON.stringify({ relayUrl: 'wss://old.example.com', clientUrl: 'https://app.example.com' }))
    const asked = fakeHost(true)
    const answered = await run(set('relayUrl', 'wss://new.example.com'), { callHost: asked.callHost, answer: 'y' })
    expect(asked.updates).toEqual([
      { enabled: false, serverUrl: 'wss://new.example.com', clientUrl: 'https://app.example.com' },
    ])
    expect(answered.out).toContain('Remote access:  off, tunnel off')

    // Unsetting the relay changes it too, to the default.
    const yes = fakeHost(true, 'wss://new.example.com')
    const unsetYes = await run(unset('relayUrl', true), { callHost: yes.callHost })
    expect(unsetYes.asked).toEqual([])
    expect(yes.updates).toEqual([{ enabled: false, serverUrl: '', clientUrl: 'https://app.example.com' }])
    expect(readJson(config())).toEqual({ clientUrl: 'https://app.example.com' })
  })
})
