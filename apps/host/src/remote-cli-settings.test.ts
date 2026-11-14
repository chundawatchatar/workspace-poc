import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { localRequest } from './app.testing'
import type { RemoteAccessEnv } from './modules/remote-access/addresses.service'
import { remoteAccessPath } from './modules/remote-access/remote-access.repository'
import {
  configFile,
  dir,
  service,
  settingsFile,
  setup,
  useRemoteAccessHarness,
} from './modules/remote-access/remote-access.testing'
import { type CallHost, createHostCaller, runRemote } from './remote-cli'

// `host:remote` and the addresses in `config.json`, against the real service
// and routes, or with no host at all.

useRemoteAccessHarness()

/** A host that refuses the connection: the CLI reads and writes the files itself. */
const stopped: CallHost = async () => null

/** The harness's host, called through `app` as a local caller. */
const through = (app: ReturnType<typeof setup>) =>
  createHostCaller('', ((url: string, init?: RequestInit) => localRequest(app, url, init)) as typeof fetch)

async function run(callHost: CallHost, args: string[], env: RemoteAccessEnv = {}) {
  const lines: string[] = []
  const code = await runRemote(args, {
    callHost,
    dataDir: dir,
    env,
    prompt: async () => null,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    now: () => Date.now(),
  })
  return { code, text: lines.join('\n') }
}

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

describe('host:remote and config.json', () => {
  test('with the host running, server saves the address for its next start, and status shows it waiting', async () => {
    const app = setup({ enabled: false, serverUrl: 'ws://127.0.0.1:4600', clientUrl: null })
    writeFileSync(configFile(), JSON.stringify({ relayUrl: 'ws://127.0.0.1:4600', logLevel: 'debug' }))
    const server = await run(through(app), ['server', 'ws://localhost:4700'])
    expect(server.code).toBe(0)
    expect(server.text).toContain('Server address saved: ws://localhost:4700. The host uses it from its next start.')
    expect(readJson(configFile())).toEqual({ relayUrl: 'ws://localhost:4700', logLevel: 'debug' })
    expect(readJson(settingsFile())).toEqual({ enabled: false })

    const status = await run(through(app), ['status'])
    expect(status.text).toContain('Server address: ws://127.0.0.1:4600\n')
    expect(status.text).toContain('Client address: derived from the server address\n')
    expect(status.text).toContain('The host uses the saved addresses from its next start.')
    service.shutdown()

    const overridden = setup(undefined, { SERVER_URL: 'wss://relay.example.com', CLIENT_URL: 'https://env.example' })
    const fromEnv = await run(through(overridden), ['status'])
    expect(fromEnv.text).toContain('Server address: wss://relay.example.com (from SERVER_URL)')
    expect(fromEnv.text).toContain('Client address: https://env.example (from CLIENT_URL)')
    expect(fromEnv.text).not.toContain('next start')
    const refused = await run(through(overridden), ['server', 'wss://other.example.com'])
    expect(refused).toEqual({ code: 1, text: 'SERVER_URL sets the server address; change it there' })
  })

  test('with the host stopped, status migrates an old remote-access.json and reads the address from config.json', async () => {
    const old = { enabled: true, serverUrl: 'wss://host', clientUrl: null }
    writeFileSync(remoteAccessPath(dir), JSON.stringify(old))
    const status = await run(stopped, ['status'])
    expect(status.text).toContain('Server address: wss://host\n')
    expect(status.text).toContain('on, tunnel host not running')
    expect(readJson(configFile())).toEqual({ relayUrl: 'wss://host' })
    expect(readJson(remoteAccessPath(dir))).toEqual({ enabled: true })

    expect((await run(stopped, ['status'], { SERVER_URL: 'ws://127.0.0.1:4600' })).text).toContain(
      'ws://127.0.0.1:4600 (from SERVER_URL)',
    )
    writeFileSync(configFile(), JSON.stringify({ relayUrl: 'wss://host', prot: 1 }))
    const broken = await run(stopped, ['status'])
    expect(broken.code).toBe(1)
    expect(broken.text).toContain('config.json: prot is not a setting')
  })

  test('with the host stopped, server writes relayUrl to config.json, on and off only the flag, and a bad file is kept', async () => {
    writeFileSync(configFile(), JSON.stringify({ logLevel: 'debug' }))
    const server = await run(stopped, ['server', ' wss://host '])
    expect(server).toEqual({ code: 0, text: 'Server address saved: wss://host. The host uses it from its next start.' })
    expect(readJson(configFile())).toEqual({ logLevel: 'debug', relayUrl: 'wss://host' })
    expect(existsSync(remoteAccessPath(dir))).toBe(false)

    expect((await run(stopped, ['on'])).text).toContain('next starts')
    expect(readJson(remoteAccessPath(dir))).toEqual({ enabled: true })

    // An old `remote-access.json` is migrated before `off` rewrites its flag.
    writeFileSync(
      remoteAccessPath(dir),
      JSON.stringify({ enabled: true, serverUrl: 'wss://old', clientUrl: 'https://c' }),
    )
    expect((await run(stopped, ['off'])).code).toBe(0)
    expect(readJson(remoteAccessPath(dir))).toEqual({ enabled: false })
    expect(readJson(configFile())).toEqual({ logLevel: 'debug', relayUrl: 'wss://host', clientUrl: 'https://c' })

    expect((await run(stopped, ['server', 'https://x'])).code).toBe(1)
    writeFileSync(remoteAccessPath(dir), '{ broken')
    for (const args of [['on'], ['off'], ['server', 'wss://host']]) expect((await run(stopped, args)).code).toBe(1)
    expect(readFileSync(remoteAccessPath(dir), 'utf8')).toBe('{ broken')
    writeFileSync(remoteAccessPath(dir), JSON.stringify({ enabled: true }))
    writeFileSync(configFile(), '{ broken')
    expect((await run(stopped, ['server', 'wss://other'])).text).toContain('is not valid JSON')
    expect(readFileSync(configFile(), 'utf8')).toBe('{ broken')
  })
})
