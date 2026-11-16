import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectUiFiles, embeddedEntrySource } from './embed-ui'

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('the embedded UI', () => {
  test("is the build's files by URL path, without dotfiles, refusing a symlink or a build with no page", () => {
    dir = mkdtempSync(join(tmpdir(), 'corch-ui-'))
    mkdirSync(join(dir, 'assets'))
    mkdirSync(join(dir, '.vite'))
    for (const file of ['index.html', 'assets/a.js', 'assets/.hidden', '.vite/manifest.json', 'favicon.svg']) {
      writeFileSync(join(dir, file), file)
    }
    expect(collectUiFiles(dir)).toEqual({
      '/assets/a.js': join(dir, 'assets/a.js'),
      '/favicon.svg': join(dir, 'favicon.svg'),
      '/index.html': join(dir, 'index.html'),
    })
    symlinkSync(join(dir, 'favicon.svg'), join(dir, 'link.svg'))
    expect(() => collectUiFiles(dir as string)).toThrow('not a plain file or folder')
    expect(() => collectUiFiles(join(dir as string, '.vite'))).toThrow('no index.html')
  })

  test('is handed in by the generated entry before it imports the host', () => {
    const source = embeddedEntrySource({
      files: { '/index.html': '/b/index.html', '/assets/a "b".js': '/b/assets/a "b".js' },
      registry: '/src/embedded-ui.ts',
      main: '/src/main.ts',
    })
    expect(source).toContain(`import file1 from "/b/assets/a \\"b\\".js" with { type: 'file' }`)
    expect(source).toContain('"/assets/a \\"b\\".js": file1,')
    expect(source.indexOf('embedUi({')).toBeGreaterThan(source.lastIndexOf('import file'))
    expect(source.trimEnd().endsWith('await import("/src/main.ts")')).toBe(true)
  })
})
