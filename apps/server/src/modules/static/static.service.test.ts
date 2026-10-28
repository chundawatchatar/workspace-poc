import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCsp, loadStaticSite } from './static.service'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('static site', () => {
  test('the CSP allows exactly the inline scripts of index.html, by hash', () => {
    const inline = 'document.documentElement.dataset.theme="dark"'
    const html = `<html><head><script>${inline}</script><script type="module" src="/assets/a.js"></script></head></html>`
    const hash = createHash('sha256').update(inline).digest('base64')
    expect(buildCsp(html)).toBe(
      `default-src 'self'; script-src 'self' 'sha256-${hash}'; style-src 'self' 'unsafe-inline'; ` +
        "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
        "form-action 'none'; frame-ancestors 'none'",
    )
  })

  test('loading a dir without index.html gives no site', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orch-static-'))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'a.js'), '')
    expect(await loadStaticSite(dir)).toBeNull()
    expect(await loadStaticSite(join(dir, 'missing'))).toBeNull()
  })
})
