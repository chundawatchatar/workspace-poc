import { describe, expect, test } from 'bun:test'
import { defineServerContract } from '@orch/shared'
import { z } from 'zod'
import { type AppDeps, createApp } from './app'
import { createServerRouter } from './lib/createServerRouter'
import { ChannelBridge } from './modules/bridge/bridge.service'
import { HttpForwarder } from './modules/forward/forward.service'
import { ConnectionLimiter } from './modules/limits/limits.service'
import { MachineRegistry } from './modules/tunnel/tunnel.service'

const stubContract = defineServerContract({
  ping: {
    method: 'GET',
    path: '/api/stub',
    description: 'test',
    auth: 'public',
    input: z.object({}),
    output: z.object({ pong: z.boolean() }),
  },
})

const stubModule = () => createServerRouter(stubContract, { ping: async () => ({ pong: true }) })

function setup(deps: Partial<AppDeps> = {}) {
  const registry = new MachineRegistry()
  const site = { root: '/nonexistent-orch-site', indexHtml: new TextEncoder().encode('<!doctype html>'), csp: 'x' }
  const app = createApp({
    registry,
    forwarder: new HttpForwarder({ registry }),
    bridge: new ChannelBridge({ registry }),
    limiter: new ConnectionLimiter(),
    site,
    ...deps,
  })
  const server = { upgrade: () => false, requestIP: () => null }
  return (path: string) => app.request(`http://orch.example${path}`, { headers: { accept: 'text/html' } }, server)
}

describe('server API', () => {
  test('serves `/api/health` and answers an unknown `/api` path with the JSON 404, never the client page', async () => {
    const request = setup()
    const health = await request('/api/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })
    for (const path of ['/api/nope', '/api']) {
      const missing = await request(path)
      expect(missing.status).toBe(404)
      expect(missing.headers.get('cache-control')).toBe('no-store')
      expect((await missing.json()) as unknown).toMatchObject({ error: { code: 'not_found' } })
    }
    expect(await (await request('/machines')).text()).toBe('<!doctype html>')
  })

  test('mounts the accounts modules only when accounts are configured', async () => {
    expect((await setup({ accounts: null })('/api/stub')).status).toBe(404)
    expect(await (await setup({ accounts: { modules: [stubModule] } })('/api/stub')).json()).toEqual({ pong: true })
  })
})
