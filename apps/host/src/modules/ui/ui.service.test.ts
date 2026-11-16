import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCsp, loadEmbeddedUiSite, loadUiSite, resolveUi } from './ui.service'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('UI site', () => {
  test('the CSP allows exactly the inline scripts of index.html, by hash', () => {
    const boot = 'document.documentElement.dataset.theme="dark"'
    const stream = '$_TSR={}'
    const html = `<html><head><script>${boot}</script><script data-tsr-stream-part="">${stream}</script><script type="module" src="/assets/a.js"></script></head></html>`
    const hash = (body: string) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`
    const csp = buildCsp(html)
    expect(csp).toContain(`script-src 'self' ${hash(boot)} ${hash(stream)};`)
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  test('a folder without index.html, or an embedded site without /index.html, loads as no site', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orch-ui-'))
    expect(await loadUiSite(dir)).toBeNull()
    expect(await loadUiSite(join(dir, 'missing'))).toBeNull()
    writeFileSync(join(dir, 'app.js'), '')
    expect(await loadEmbeddedUiSite({ '/app.js': join(dir, 'app.js') })).toBeNull()
    expect(await loadEmbeddedUiSite({ '/index.html': join(dir, 'missing.html') })).toBeNull()
  })

  test('an embedded site resolves every path as the folder site with the same files does', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-ui-'))
    dir = root
    mkdirSync(join(root, 'assets'))
    const files = ['index.html', 'assets/index-abc.js', 'assets/a b.css', 'favicon.svg']
    for (const file of files) writeFileSync(join(root, file), file)
    const folder = await loadUiSite(root)
    const embedded = await loadEmbeddedUiSite(Object.fromEntries(files.map((file) => [`/${file}`, join(root, file)])))
    if (!folder || !embedded) throw new Error('no site')
    expect(embedded.indexHtml).toEqual(folder.indexHtml)
    expect(embedded.csp).toBe(folder.csp)
    const paths = [
      ...['/', '/index.html', '//index.html', '/assets/index-abc.js', '/assets//index-abc.js', '/assets/a%20b.css'],
      ...['/favicon.svg', '/w/ws_1', '/assets/missing.js', '/assets', '/.env', '/assets/%2e%2e/index.html'],
      ...['/%2e%2e%2findex.html', '/assets%2findex-abc.js', '/%zz', '/api/health', '/ws/term/t1', '/%61pi/x'],
    ]
    for (const path of paths) {
      for (const acceptsHtml of [true, false]) {
        const [a, b] = [await resolveUi(folder, path, acceptsHtml), await resolveUi(embedded, path, acceptsHtml)]
        // The two read a file from different places, so only where it sits in the site is compared.
        const same = (target: typeof a) => (target.kind === 'file' ? { kind: 'file', at: target.sitePath } : target)
        expect({ path, acceptsHtml, target: same(b) }).toEqual({ path, acceptsHtml, target: same(a) })
      }
    }
    expect(await resolveUi(embedded, '/assets/a%20b.css', false)).toMatchObject({ sitePath: '/assets/a b.css' })
  })
})
