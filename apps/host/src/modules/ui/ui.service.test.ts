import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCsp, loadUiSite } from './ui.service'

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

  test('a folder without index.html loads as no site', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orch-ui-'))
    expect(await loadUiSite(dir)).toBeNull()
    expect(await loadUiSite(join(dir, 'missing'))).toBeNull()
  })
})
