import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { machinePathPrefix, TUNNEL_PATH } from '@orch/shared'
import { createApp } from '../../app'
import { ChannelBridge } from '../bridge/bridge.service'
import { HttpForwarder } from '../forward/forward.service'
import { ConnectionLimiter } from '../limits/limits.service'
import { MachineRegistry } from '../tunnel/tunnel.service'
import { loadStaticSite, resolveStatic, type StaticSite } from './static.service'

const indexHtml = '<!doctype html><html><head><script>boot()</script></head><body></body></html>'
const script = new Uint8Array([0x63, 0x6f, 0x6e, 0x73, 0x74, 0xff, 0x00])
const html = { accept: 'text/html,application/xhtml+xml' }

let root: string
let dir: string

beforeEach(() => {
  // The site dir sits inside `root`, next to a secret that a symlink points out to.
  root = mkdtempSync(join(tmpdir(), 'orch-static-'))
  dir = join(root, 'dist')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), indexHtml)
  writeFileSync(join(dir, 'assets', 'index-abc.js'), script)
  writeFileSync(join(dir, 'favicon.svg'), '<svg/>')
  writeFileSync(join(dir, '.env'), 'SECRET=1')
  writeFileSync(join(root, 'secret.txt'), 'secret')
  symlinkSync(join(root, 'secret.txt'), join(dir, 'leak.txt'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function setup(site: StaticSite | null) {
  const registry = new MachineRegistry()
  const app = createApp({
    registry,
    forwarder: new HttpForwarder({ registry }),
    bridge: new ChannelBridge({ registry }),
    limiter: new ConnectionLimiter(),
    site,
  })
  // Stands in for the Bun server, which refuses to upgrade a plain request.
  const server = { upgrade: () => false, requestIP: () => null }
  return (path: string, init?: RequestInit) => app.request(`http://orch.example${path}`, init, server)
}

describe('static routes', () => {
  test('serve files byte for byte with their type, immutable assets and an uncached page with its CSP', async () => {
    const site = await loadStaticSite(dir)
    const request = setup(site)

    const asset = await request('/assets/index-abc.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect([...new Uint8Array(await asset.arrayBuffer())]).toEqual([...script])
    expect(asset.headers.get('x-frame-options')).toBe('DENY')

    const head = await request('/assets/index-abc.js', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toContain('javascript')
    expect(await head.text()).toBe('')

    const icon = await request('/favicon.svg')
    expect(icon.headers.get('content-type')).toContain('image/svg+xml')
    expect(icon.headers.get('cache-control')).toBeNull()

    for (const path of ['/', '/index.html']) {
      const page = await request(path)
      expect(await page.text()).toBe(indexHtml)
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(page.headers.get('cache-control')).toBe('no-cache')
      expect(page.headers.get('content-security-policy')).toBe(site?.csp ?? '')
    }
  })

  test('fall back to the page for HTML requests to client routes, but leave relay paths to the relay', async () => {
    const request = setup(await loadStaticSite(dir))
    const machine = machinePathPrefix('m1')
    for (const path of [machine, `${machine}/w/ws1`, '/settings']) {
      const page = await request(path, { headers: html })
      expect(page.status).toBe(200)
      expect(await page.text()).toBe(indexHtml)
    }
    expect((await request('/assets/missing.js')).status).toBe(404)
    // The machine is offline, so reaching the forwarder shows as 502.
    expect((await request(`${machine}/api/health`, { headers: html })).status).toBe(502)
    for (const path of [`${machine}/ws/events`, `${machine}/api`, TUNNEL_PATH]) {
      expect((await request(path, { headers: html })).status).toBe(404)
    }
  })

  test('refuse dot segments, dotfiles, symlinks out of the dir and other methods with 404', async () => {
    const site = await loadStaticSite(dir)
    if (!site) throw new Error('no site')
    // Bun and the URL parser resolve dot segments before the app sees them, so check the raw path too.
    for (const path of ['/../secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/.env']) {
      expect({ path, target: await resolveStatic(site, path, true) }).toEqual({ path, target: { kind: 'not-found' } })
    }
    const request = setup(site)
    for (const path of [
      '/../secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/.env',
      '/leak.txt',
    ]) {
      expect({ path, status: (await request(path)).status }).toEqual({ path, status: 404 })
      expect(await (await request(path, { headers: html })).text()).not.toContain('secret')
    }
    expect((await request('/leak.txt', { headers: html })).status).toBe(404)
    expect((await request('/', { method: 'POST', headers: html })).status).toBe(404)
    expect((await request('/assets/index-abc.js', { method: 'DELETE' })).status).toBe(404)
  })

  test('without a build, answer 404 outside the relay and relay as before', async () => {
    const request = setup(null)
    expect((await request('/', { headers: html })).status).toBe(404)
    expect((await request(`${machinePathPrefix('m1')}/w/ws1`, { headers: html })).status).toBe(404)
    expect((await request(`${machinePathPrefix('m1')}/api/health`)).status).toBe(502)
  })
})
