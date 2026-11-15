import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDataFolder } from './data-folder'

let root: string
afterEach(() => rmSync(root, { recursive: true, force: true }))

const mode = (path: string) => statSync(path).mode & 0o777

describe('ensureDataFolder', () => {
  test('creates a missing folder and its parents with mode 0700, and accepts an existing 0700 folder', () => {
    root = mkdtempSync(join(tmpdir(), 'corch-folder-'))
    const dir = join(root, 'a', 'b', 'data')
    expect(ensureDataFolder(dir)).toBeNull()
    expect(mode(dir)).toBe(0o700)
    expect(ensureDataFolder(dir)).toBeNull()
  })

  test('refuses an open folder, a symlink and a file, naming the path and changing nothing', () => {
    root = mkdtempSync(join(tmpdir(), 'corch-folder-'))
    const open = join(root, 'open')
    mkdirSync(open)
    chmodSync(open, 0o755)
    writeFileSync(join(open, 'config.json'), '{}')
    const refused = ensureDataFolder(open)
    expect(refused).toContain(open)
    expect(refused).toContain(`chmod 700 ${open}`)
    expect(mode(open)).toBe(0o755)
    expect(readdirSync(open)).toEqual(['config.json'])

    const target = join(root, 'target')
    mkdirSync(target, { mode: 0o700 })
    const link = join(root, 'link')
    symlinkSync(target, link)
    expect(ensureDataFolder(link)).toContain(link)
    expect(readdirSync(target)).toEqual([])

    const file = join(root, 'file')
    writeFileSync(file, 'x')
    expect(ensureDataFolder(file)).toContain(file)
    for (const dir of [open, target]) expect(existsSync(join(dir, 'corch.lock'))).toBe(false)
  })

  test('refuses a folder owned by another user', () => {
    root = mkdtempSync(join(tmpdir(), 'corch-folder-'))
    chmodSync(root, 0o700)
    const owner = statSync(root).uid
    expect(ensureDataFolder(root, owner)).toBeNull()
    const refused = ensureDataFolder(root, owner + 1)
    expect(refused).toContain(root)
    expect(refused).toContain('owned by another user')
  })
})
