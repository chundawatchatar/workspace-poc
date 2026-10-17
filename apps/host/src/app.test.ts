import { describe, expect, test } from 'bun:test'
import { type AppDeps, createApp } from './app'

// The HTTP routes under test don't touch the long-lived services.
const app = createApp({} as AppDeps)

describe('createApp', () => {
  test('serves the module routes under /api', async () => {
    expect(await (await app.request('/api/health')).json()).toEqual({ ok: true })
  })

  test('refuses requests from pages on other origins', async () => {
    const response = await app.request('/api/health', { headers: { origin: 'https://example.com' } })
    expect(response.status).toBe(403)
  })
})
