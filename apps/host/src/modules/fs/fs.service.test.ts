import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandDir, listDirs, makeDir } from './fs.service'

describe('expandDir', () => {
  test('expands ~ to the home folder', () => {
    expect(expandDir('~')).toBe(homedir())
  })

  test('returns null for relative paths and missing folders', () => {
    expect(expandDir('relative/folder')).toBeNull()
    expect(expandDir(`${homedir()}/no-such-folder-${Date.now()}`)).toBeNull()
  })
})

describe('listDirs', () => {
  test('lists visible subfolders sorted by name, with the parent folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'list-dirs-'))
    for (const name of ['beta', 'Alpha', '.hidden']) mkdirSync(join(root, name))
    writeFileSync(join(root, 'file.txt'), '')
    expect(listDirs(root).dirs).toEqual(['Alpha', 'beta'])
    expect(listDirs(join(root, 'beta')).parent).toBe(root)
  })

  test('has no parent at the root and no path for a missing folder', () => {
    expect(listDirs('/').parent).toBeNull()
    expect(listDirs('relative').path).toBeNull()
  })
})

describe('makeDir', () => {
  test('creates the folder once, and rejects names with slashes', () => {
    const root = mkdtempSync(join(tmpdir(), 'make-dir-'))
    expect(makeDir(root, 'new')).toEqual({ path: join(root, 'new'), error: null })
    expect(listDirs(root).dirs).toEqual(['new'])
    expect(makeDir(root, 'new').path).toBeNull()
    expect(makeDir(root, '../escape').path).toBeNull()
  })
})
