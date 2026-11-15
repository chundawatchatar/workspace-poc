import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRunFile, runFilePath, writeRunFile } from './process-files'

let root: string
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('writeRunFile', () => {
  test('never writes through a symlink at its temp path', () => {
    root = mkdtempSync(join(tmpdir(), 'corch-run-'))
    const dataDir = join(root, 'data')
    const outside = join(root, 'outside')
    mkdirSync(dataDir, { mode: 0o700 })
    writeFileSync(outside, 'untouched')
    symlinkSync(outside, `${runFilePath(dataDir)}.${process.pid}.tmp`)

    const record = { pid: process.pid, instanceId: 'i', startedAt: 1, url: 'http://127.0.0.1:1' }
    writeRunFile(dataDir, record)
    expect(readFileSync(outside, 'utf8')).toBe('untouched')
    const stat = lstatSync(runFilePath(dataDir))
    expect([stat.isFile(), stat.mode & 0o777]).toEqual([true, 0o600])
    expect(readRunFile(dataDir)?.record).toEqual(record)
    expect(readdirSync(dataDir)).toEqual(['corch.run.json'])
    expect(existsSync(outside)).toBe(true)
  })
})
