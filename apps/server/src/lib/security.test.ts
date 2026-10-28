import { describe, expect, test } from 'bun:test'
import { ACCESS_KEY_HEADER, machinePathPrefix } from '@orch/shared'
import { createApp } from '../app'
import { ChannelBridge } from '../modules/bridge/bridge.service'
import { HttpForwarder } from '../modules/forward/forward.service'
import { ConnectionLimiter } from '../modules/limits/limits.service'
import { MachineRegistry } from '../modules/tunnel/tunnel.service'
import { SECURITY_HEADERS } from './security'

const host = 'orch.example'
const allowed = 'http://127.0.0.1:3220'

/** The server's app with no machines, allowing `allowed` as a cross origin. */
function setup() {
  const registry = new MachineRegistry()
  const app = createApp({
    registry,
    forwarder: new HttpForwarder({ registry }),
    bridge: new ChannelBridge({ registry }),
    limiter: new ConnectionLimiter(),
    allowedOrigins: [allowed],
  })
  return (path: string, init: RequestInit = {}) =>
    app.request(`http://${host}${path}`, { ...init, headers: { host, ...init.headers } })
}

const api = `${machinePathPrefix('m1')}/api/system/health`

function corsHeaders(response: Response) {
  return [...response.headers.keys()].filter((name) => name.startsWith('access-control-'))
}

describe('security', () => {
  test('every response carries the baseline headers, even a 404 and a relay error', async () => {
    const request = setup()
    for (const response of [await request('/nowhere'), await request(api)]) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers.get(name)).toBe(value)
    }
  })

  test('a machine request from a foreign origin gets 403 with no CORS headers; own and listed origins pass', async () => {
    const request = setup()
    const foreign = await request(api, { headers: { origin: 'https://evil.example' } })
    expect(foreign.status).toBe(403)
    expect(corsHeaders(foreign)).toEqual([])
    const socket = await request(`${machinePathPrefix('m1')}/ws/events`, {
      headers: { origin: 'https://evil.example', upgrade: 'websocket' },
    })
    expect(socket.status).toBe(403)
    expect((await request(api, { headers: { origin: 'null' } })).status).toBe(403)

    // The machine is offline, so a request that passes the origin check gets the forwarder's 502.
    const own = await request(api, { headers: { origin: `https://${host}` } })
    expect(own.status).toBe(502)
    expect(corsHeaders(own)).toEqual([])
    expect((await request(api)).status).toBe(502)
    const cross = await request(api, { headers: { origin: allowed } })
    expect(cross.status).toBe(502)
    expect(cross.headers.get('access-control-allow-origin')).toBe(allowed)
    expect(cross.headers.get('vary')).toBe('Origin')
    expect(cross.headers.has('access-control-allow-credentials')).toBe(false)
  })

  test('the server answers preflights itself: 204 for an allowed origin, 403 for any other', async () => {
    const request = setup()
    const preflight = (origin: string) =>
      request(api, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': ACCESS_KEY_HEADER,
        },
      })
    const ok = await preflight(allowed)
    expect(ok.status).toBe(204)
    expect(ok.headers.get('access-control-allow-origin')).toBe(allowed)
    expect(ok.headers.get('vary')).toBe('Origin')
    expect(ok.headers.get('access-control-allow-methods')).toContain('POST')
    expect(ok.headers.get('access-control-allow-headers')).toBe(`${ACCESS_KEY_HEADER}, content-type`)
    expect(ok.headers.get('access-control-max-age')).toBe('600')

    const denied = await preflight('https://evil.example')
    expect(denied.status).toBe(403)
    expect(corsHeaders(denied)).toEqual([])
  })
})
