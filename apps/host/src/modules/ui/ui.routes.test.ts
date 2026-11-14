import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionManager } from '@orch/terminal'
import { type AppDeps, createApp } from '../../app'
import { tunnelEnv } from '../../lib/principal'
import { SANDBOX_CSP } from './ui.routes'
import { loadUiSite, resolveUi } from './ui.service'

const indexHtml = '<!doctype html><html><head><script>boot()</script></head><body></body></html>'
const script = new Uint8Array([0x63, 0x6f, 0x6e, 0x73, 0x74, 0xff, 0x00])
const html = { accept: 'text/html,application/xhtml+xml' }
const tunneled = tunnelEnv({ kind: 'key', keyId: 'k1', name: 'laptop', deviceId: 'd1' })

let root: string
let dir: string

beforeEach(() => {
  // The UI folder sits inside `root`, next to a secret that a symlink points out to.
  root = mkdtempSync(join(tmpdir(), 'orch-ui-'))
  dir = join(root, 'dist')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), indexHtml)
  writeFileSync(join(dir, 'assets', 'index-abc.js'), script)
  writeFileSync(join(dir, '.env'), 'SECRET=1')
  writeFileSync(join(root, 'secret.txt'), 'secret')
  symlinkSync(join(root, 'secret.txt'), join(dir, 'leak.txt'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// The UI routes under test only need the health route beside them, which reads nothing.
async function setup(withUi = true) {
  const ui = withUi ? await loadUiSite(dir) : null
  return createApp({ sessions: { list: () => [] } as unknown as SessionManager, ui } as AppDeps).app
}

describe('UI routes', () => {
  test('without a site no UI is served and the API is unchanged', async () => {
    const app = await setup(false)
    expect((await app.request('/', { headers: html })).status).toBe(404)
    expect((await app.request('/assets/index-abc.js')).status).toBe(404)
    expect((await app.request('/api/health')).status).toBe(200)
  })

  test("the page and the UI's own routes get index.html with its CSP and security headers", async () => {
    const app = await setup()
    for (const path of ['/', '/w/ws_1', '/index.html']) {
      const response = await app.request(path, { headers: html })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(indexHtml)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(response.headers.get('cache-control')).toBe('no-cache')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('x-frame-options')).toBe('DENY')
      const hash = new Bun.CryptoHasher('sha256').update('boot()').digest('base64')
      expect(response.headers.get('content-security-policy')).toContain(`script-src 'self' 'sha256-${hash}'`)
    }
  })

  test('assets are served byte for byte, cached for good and sandboxed', async () => {
    const app = await setup()
    for (const method of ['GET', 'HEAD']) {
      const response = await app.request('/assets/index-abc.js', { method })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(response.headers.get('content-security-policy')).toBe(SANDBOX_CSP)
      if (method === 'GET') expect(new Uint8Array(await response.arrayBuffer())).toEqual(script)
    }
  })

  test('paths that leave the folder, other methods and API paths never get a file or the page', async () => {
    const app = await setup()
    const site = await loadUiSite(dir)
    if (!site) throw new Error('no site')
    const leaving = ['/../secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/.env', '/leak.txt']
    for (const path of leaving) {
      // The URL parser resolves dot segments before the app sees them, so the raw path is checked on its own too.
      expect({ path, target: await resolveUi(site, path, true) }).toEqual({ path, target: { kind: 'not-found' } })
      expect({ path, status: (await app.request(path)).status }).toEqual({ path, status: 404 })
      expect(await (await app.request(path, { headers: html })).text()).not.toContain('secret')
    }
    expect((await app.request('/leak.txt', { headers: html })).status).toBe(404)
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await app.request('/', { method, headers: html })).status).toBe(404)
    }
    for (const path of ['/api/nope', '/ws/nope', '/api', '/%61pi/nope']) {
      const response = await app.request(path, { headers: html })
      expect(response.status).toBe(404)
      expect(await response.text()).not.toBe(indexHtml)
    }
  })

  test('a foreign origin gets 403 and a tunneled request gets 404, for the page and assets alike', async () => {
    const app = await setup()
    for (const path of ['/', '/assets/index-abc.js']) {
      const foreign = await app.request(path, { headers: { ...html, origin: 'http://evil.example' } })
      expect(foreign.status).toBe(403)
      const throughTunnel = await app.request(path, { headers: html }, tunneled)
      expect(throughTunnel.status).toBe(404)
      expect(await throughTunnel.text()).not.toBe(indexHtml)
    }
  })
})
