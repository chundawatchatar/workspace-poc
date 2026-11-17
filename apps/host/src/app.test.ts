import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { websocket } from '@hono/bun'
import { daemonResponse, routes } from '@orch/shared'
import type { SessionManager, TerminalSession } from '@orch/terminal'
import { type AppDeps, createApp } from './app'
import { LOCAL_PORT, localRequest } from './app.testing'
import { tunnelEnv } from './lib/principal'
import { loadUiSite } from './modules/ui/ui.service'

function fakeSession(alive: boolean) {
  return { info: () => ({ alive }) } as TerminalSession
}

// The HTTP routes under test only read the session list and the daemon's start time.
const sessions = { list: () => [fakeSession(true), fakeSession(true), fakeSession(false)] } as SessionManager
const daemon = () => ({
  startedAt: Date.now() - 90_000,
  compatibility: 'outdated' as const,
  daemonProtocol: 1,
  stopCommand: 'bun run terminals:stop',
})
const { app } = createApp({ sessions, daemon } as AppDeps)

const html = { accept: 'text/html' }
const upgrade = {
  connection: 'Upgrade',
  upgrade: 'websocket',
  'sec-websocket-version': '13',
  'sec-websocket-key': 'a2V5',
}

let dir: string
/** Every dep a route reached for, and every socket upgrade attempted, after the app was built. */
let reached: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-app-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body></body></html>')
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'run()')
  reached = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Wraps `target` so any property read once `armed()` is true is recorded under `name`. */
function watched<T extends object>(name: string, target: T, armed: () => boolean): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      if (armed()) reached.push(`${name}.${String(key)}`)
      return Reflect.get(object, key, receiver)
    },
  })
}

/** An app with the built UI, whose deps and site record every read made while handling a request. */
async function watchedApp() {
  const site = await loadUiSite(dir)
  if (!site) throw new Error('no site')
  let armed = false
  const stub = { list: () => [] }
  const deps = {
    sessions: watched('sessions', stub, () => armed),
    daemon: () => {
      reached.push('daemon')
      return null
    },
    instanceId: 'test-instance',
    machinePublicKey: () => {
      reached.push('machinePublicKey')
      return null
    },
    ui: watched('ui', site, () => armed),
  }
  const built = createApp(watched('deps', deps, () => armed) as unknown as AppDeps).app
  armed = true
  return built
}

/** A Bun server stand-in that records an upgrade instead of making one. */
const serverEnv = (port = LOCAL_PORT) => ({
  port,
  upgrade: () => {
    reached.push('upgrade')
    return false
  },
})

/** The requests every refused `Host` is tried with: the API, the page, an asset and a socket upgrade. */
const requests: [string, Record<string, string>][] = [
  [routes.system.health.path, {}],
  [routes.system.daemon.path, {}],
  ['/', html],
  ['/assets/index-abc.js', {}],
  [routes.sockets.events.path, upgrade],
]

describe('createApp', () => {
  test('serves the module routes under /api', async () => {
    expect(await (await localRequest(app, '/api/health')).json()).toEqual({ ok: true })
  })

  test('reports the daemon uptime and the terminals whose shell is alive', async () => {
    const response = await localRequest(app, '/api/daemon')
    expect(response.status).toBe(200)
    const body = daemonResponse.parse(await response.json())
    expect(body.liveTerminals).toBe(2)
    expect(body.uptimeMs).toBeGreaterThanOrEqual(90_000)
    expect(body.uptimeMs).toBeLessThan(91_000)
  })

  test('refuses requests from pages on other origins', async () => {
    const response = await localRequest(app, '/api/health', { headers: { origin: 'https://example.com' } })
    expect(response.status).toBe(403)
  })
})

describe('the Host check', () => {
  test('refuses a foreign or missing Host, the wrong port and a missing server before any route runs', async () => {
    const watchedHost = await watchedApp()
    const refusals: [string | null, object | undefined][] = [
      ['evil.example:4599', serverEnv()],
      ['127.0.0.1:4600', serverEnv()],
      ['localhost:4599', serverEnv(4600)],
      [null, serverEnv()],
      ['127.0.0.1:4599', undefined],
      ['127.0.0.1:4599', {}],
    ]
    for (const [host, env] of refusals) {
      for (const [path, headers] of requests) {
        const response = await watchedHost.request(path, { headers: { ...headers, ...(host ? { host } : {}) } }, env)
        expect({ host, env, path, status: response.status }).toEqual({ host, env, path, status: 403 })
        expect(await response.text()).toBe('forbidden')
      }
    }
    expect(reached).toEqual([])
  })

  test('answers each loopback name on the listening port as before', async () => {
    const watchedHost = await watchedApp()
    for (const host of ['127.0.0.1:4599', 'localhost:4599', 'LOCALHOST:4599', '[::1]:4599']) {
      const request = (path: string, headers: Record<string, string> = {}) =>
        watchedHost.request(path, { headers: { ...headers, host } }, serverEnv())
      expect(await (await request(routes.system.health.path)).json()).toEqual({ ok: true })
      expect((await request('/', html)).headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(await (await request('/assets/index-abc.js')).text()).toBe('run()')
      expect((await request(routes.system.health.path, { origin: 'https://example.com' })).status).toBe(403)
      reached = []
      await request(routes.sockets.events.path, upgrade)
      expect(reached).toContain('upgrade')
    }
  })

  test('never refuses a tunneled request for its Host', async () => {
    const tunneled = tunnelEnv({ kind: 'account', accountId: 'u1', deviceId: 'd1', ticketExp: 4_102_444_800 })
    for (const host of [null, 'evil.example', 'relay.example:443']) {
      const response = await app.request('/api/health', { headers: host ? { host } : {} }, tunneled)
      expect({ host, status: response.status }).toEqual({ host, status: 200 })
    }
  })
})

describe('the Host check on a real server', () => {
  let server: ReturnType<typeof Bun.serve> | undefined

  afterEach(() => {
    server?.stop(true)
    server = undefined
  })

  test('answers its own address and refuses a foreign Host, for HTTP and a socket upgrade', async () => {
    const started = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket })
    server = started
    const { port } = started
    if (port === undefined) throw new Error('the server has no port')
    const url = `http://127.0.0.1:${port}/api/health`
    expect((await fetch(url)).status).toBe(200)
    expect((await fetch(url, { headers: { host: `evil.example:${port}` } })).status).toBe(403)

    // A raw upgrade, so the `Host` is exactly what a rebinding page's browser would send.
    const chunks: string[] = []
    const { promise: answered, resolve } = Promise.withResolvers<void>()
    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        data: (_socket, data) => {
          chunks.push(data.toString())
          resolve()
        },
        close: () => resolve(),
      },
    })
    socket.write(
      [
        `GET ${routes.sockets.events.path} HTTP/1.1`,
        `Host: evil.example:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n'),
    )
    await answered
    socket.end()
    const response = chunks.join('')
    expect(response.startsWith('HTTP/1.1 403')).toBe(true)
    expect(response).not.toContain('101')
  })
})
