import { describe, expect, test } from 'bun:test'
import { daemonResponse } from '@orch/shared'
import type { SessionManager, TerminalSession } from '@orch/terminal'
import { type AppDeps, createApp } from './app'

function fakeSession(alive: boolean) {
  return { info: () => ({ alive }) } as TerminalSession
}

// The HTTP routes under test only read the session list and the daemon's start time.
const sessions = { list: () => [fakeSession(true), fakeSession(true), fakeSession(false)] } as SessionManager
const app = createApp({ sessions, daemonStartedAt: () => Date.now() - 90_000 } as AppDeps)

describe('createApp', () => {
  test('serves the module routes under /api', async () => {
    expect(await (await app.request('/api/health')).json()).toEqual({ ok: true })
  })

  test('reports the daemon uptime and the terminals whose shell is alive', async () => {
    const response = await app.request('/api/daemon')
    expect(response.status).toBe(200)
    const body = daemonResponse.parse(await response.json())
    expect(body.liveTerminals).toBe(2)
    expect(body.uptimeMs).toBeGreaterThanOrEqual(90_000)
    expect(body.uptimeMs).toBeLessThan(91_000)
  })

  test('refuses requests from pages on other origins', async () => {
    const response = await app.request('/api/health', { headers: { origin: 'https://example.com' } })
    expect(response.status).toBe(403)
  })
})
