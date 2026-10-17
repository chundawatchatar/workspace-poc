import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { expandDir } from './fs.service'

describe('expandDir', () => {
  test('expands ~ to the home folder', () => {
    expect(expandDir('~')).toBe(homedir())
  })

  test('returns null for relative paths and missing folders', () => {
    expect(expandDir('relative/folder')).toBeNull()
    expect(expandDir(`${homedir()}/no-such-folder-${Date.now()}`)).toBeNull()
  })
})
