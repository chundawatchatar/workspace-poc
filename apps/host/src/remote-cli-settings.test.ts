import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { localRequest } from './app.testing'
import type { RemoteAccessEnv } from './modules/remote-access/addresses.service'
import { remoteAccessPath } from './modules/remote-access/remote-access.repository'
import {
  configFile,
  dir,
  email,
  fakeServer,
  key,
  linkedFile,
  setup,
  tunnels,
  useRemoteAccessHarness,
} from './modules/remote-access/remote-access.testing'
import { type CallHost, createHostCaller, runRemote } from './remote-cli'
import { REMOVE_IN_CLIENT } from './remote-cli-connect'

// `host:remote` and the addresses in `config.json`, against the real service
// and routes, or with no host at all.

useRemoteAccessHarness()

/** A host that refuses the connection: the CLI reads the files itself. */
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
  test('connect saves the address with the running host, status shows it, and disconnect forgets the account', async () => {
    const app = setup({ serverUrl: 'ws://127.0.0.1:4600' })
    writeFileSync(configFile(), JSON.stringify({ relayUrl: 'ws://127.0.0.1:4600', logLevel: 'debug' }))
    const args = ['connect', '--email', email, '--key', key, '--server', 'ws://localhost:4700', '--yes']
    const connected = await run(through(app), args)
    expect(connected.code).toBe(0)
    expect(connected.text).toContain('Connected to Ada (a***@example.com) through ws://localhost:4700')
    expect(readJson(configFile())).toEqual({ relayUrl: 'ws://localhost:4700', logLevel: 'debug' })
    expect(tunnels.map((t) => t.options.url)).toEqual(['ws://localhost:4700/tunnel'])

    const status = await run(through(app), ['status'])
    expect(status.text).toContain('Server address: ws://localhost:4700\n')
    expect(status.text).toContain('Client address: derived from the server address\n')
    expect(status.text).toContain('Connection:     connected, tunnel connected')

    fakeServer.unlink = () => ({ type: 'unlink.failed', id: 1, code: 'unavailable' })
    const disconnected = await run(through(app), ['disconnect', '--yes'])
    expect(disconnected).toMatchObject({ code: 0, text: expect.stringContaining(REMOVE_IN_CLIENT) })
    expect(existsSync(linkedFile())).toBe(false)
    expect((await run(through(app), ['status'])).text).toContain('Connection:     not connected, tunnel off')
  })

  test('with the host running, status names the variables that set the addresses', async () => {
    const app = setup(undefined, { SERVER_URL: 'wss://relay.example.com', CLIENT_URL: 'https://env.example' })
    const fromEnv = await run(through(app), ['status'])
    expect(fromEnv.text).toContain('Server address: wss://relay.example.com (from SERVER_URL)')
    expect(fromEnv.text).toContain('Client address: https://env.example (from CLIENT_URL)')
  })

  test('with the host stopped, status migrates an old remote-access.json and reads the address from config.json', async () => {
    const old = { enabled: true, serverUrl: 'wss://host', clientUrl: null }
    writeFileSync(remoteAccessPath(dir), JSON.stringify(old))
    const status = await run(stopped, ['status'])
    expect(status.text).toContain('Server address: wss://host\n')
    // The old switch turns nothing on: only a linked account connects the machine.
    expect(status.text).toContain('Connection:     not connected, tunnel host not running')
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
})
