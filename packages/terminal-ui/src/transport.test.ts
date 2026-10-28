import { afterEach, describe, expect, test } from 'bun:test'
import { ACCESS_KEY_HEADER, buildRequest, buildSocketUrl, routes } from '@orch/shared'
import { callApi } from './lib/api'
import { connect, getSnapshot } from './lib/store'
import { createLocalTransport, createRemoteTransport, type HostTransport } from './transport'

/** Records what the page asks for, instead of reaching a host. */
function fakeTransport() {
  const requests: { path: string; init: RequestInit }[] = []
  const sockets: { path: string; closed: boolean; socket: WebSocket }[] = []
  const transport: HostTransport = {
    request: async (path, init) => {
      requests.push({ path, init })
      return Response.json({ branch: 'main', changes: 2 })
    },
    openSocket: (path) => {
      const entry = { path, closed: false, socket: {} as WebSocket }
      entry.socket = { close: () => (entry.closed = true) } as unknown as WebSocket
      sockets.push(entry)
      return entry.socket
    },
  }
  return { transport, requests, sockets }
}

let disconnect = () => {}
afterEach(() => disconnect())

describe('the page transport', () => {
  test('carries the events socket and every API call, and its cleanup stops reconnecting', async () => {
    const fake = fakeTransport()
    disconnect = connect(fake.transport)
    expect(fake.sockets.map((s) => s.path)).toEqual([buildSocketUrl(routes.sockets.events, {})])

    const git = await callApi(routes.git.status, { cwd: '/tmp/project' })
    expect(git).toEqual({ branch: 'main', changes: 2 })
    expect(fake.requests.map((r) => r.path)).toEqual([buildRequest(routes.git.status, { cwd: '/tmp/project' }).url])
    expect(fake.requests[0].init.method).toBe('GET')

    disconnect()
    expect(fake.sockets[0].closed).toBe(true)
    // A close that arrives after the cleanup must not mark the page offline or schedule a reconnect.
    fake.sockets[0].socket.onclose?.({} as CloseEvent)
    expect(getSnapshot().status).toBe('connecting')
    await expect(callApi(routes.git.status, { cwd: '/tmp' })).rejects.toThrow()
  })

  test('the local transport maps paths onto its base URL, with a ws:// scheme for sockets', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: 'localhost',
      fetch: (req) => new Response(new URL(req.url).pathname),
    })
    try {
      const base = `http://localhost:${server.port}`
      const transport = createLocalTransport(base)
      const { url } = buildRequest(routes.git.status, { cwd: '/tmp' })
      const response = await transport.request(url, { method: 'GET' })
      expect(await response.text()).toBe(routes.git.status.path)

      const path = buildSocketUrl(routes.sockets.events, {})
      const socket = transport.openSocket(path)
      expect(socket.url).toBe(`ws://localhost:${server.port}${path}`)
      socket.close()
    } finally {
      server.stop(true)
    }
  })

  test('the remote transport goes through the machine prefix and carries the key in a header or the first message', async () => {
    const machineId = 'mac/1 a'
    const accessKey = 'secret-key'
    const seen: { url: string; headers: Record<string, string> }[] = []
    const messages: string[] = []
    const { promise: twoMessages, resolve } = Promise.withResolvers<void>()
    const server = Bun.serve({
      port: 0,
      hostname: 'localhost',
      fetch(req, srv) {
        seen.push({ url: req.url, headers: Object.fromEntries(req.headers) })
        if (srv.upgrade(req)) return
        return new Response('ok')
      },
      websocket: {
        message(_ws, message) {
          messages.push(String(message))
          if (messages.length === 2) resolve()
        },
      },
    })
    try {
      const base = `http://localhost:${server.port}`
      const transport = createRemoteTransport({ serverUrl: `${base}/`, machineId, accessKey })

      await transport.request('/api/git/status?cwd=%2Ftmp', { headers: { 'content-type': 'application/json' } })
      expect(seen[0].url).toBe(`${base}/m/mac%2F1%20a/api/git/status?cwd=%2Ftmp`)
      expect(seen[0].headers['content-type']).toBe('application/json')
      expect(seen[0].headers[ACCESS_KEY_HEADER]).toBe(accessKey)

      const socket = transport.openSocket('/ws/events')
      expect(socket.url).toBe(`ws://localhost:${server.port}/m/mac%2F1%20a/ws/events`)
      socket.onopen = () => socket.send('from the page')
      await twoMessages
      socket.close()
      expect(messages).toEqual([JSON.stringify({ type: 'auth', key: accessKey }), 'from the page'])
      expect(seen.every((s) => !s.url.includes(accessKey))).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test('the remote transport uses wss:// for an https server and rejects other schemes', () => {
    const opened: string[] = []
    const RealWebSocket = globalThis.WebSocket
    // Records the URL without reaching a TLS server.
    globalThis.WebSocket = class {
      constructor(url: string) {
        opened.push(url)
      }
      addEventListener() {}
    } as unknown as typeof WebSocket
    try {
      createRemoteTransport({ serverUrl: 'https://example.com', machineId: 'm1', accessKey: 'k' }).openSocket(
        '/ws/events',
      )
      expect(opened).toEqual(['wss://example.com/m/m1/ws/events'])
    } finally {
      globalThis.WebSocket = RealWebSocket
    }
    for (const serverUrl of ['ws://example.com', 'file:///tmp', 'javascript:alert(1)']) {
      expect(() => createRemoteTransport({ serverUrl, machineId: 'm1', accessKey: 'k' })).toThrow()
    }
  })
})
