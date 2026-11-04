import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRootEnv, requiredEnv, urlFromEnv } from './env'

let dir: string | undefined

function setup(content: string) {
  dir = mkdtempSync(join(tmpdir(), 'orch-env-'))
  const path = join(dir, '.env')
  writeFileSync(path, content)
  return path
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('loadRootEnv', () => {
  test('sets variables from the file but never overwrites ones already set', () => {
    const path = setup('SMTP_URL=smtp://127.0.0.1:1025\nPOSTGRES_DB=from-file\n')
    const env: Record<string, string | undefined> = { POSTGRES_DB: 'from-shell' }
    loadRootEnv({ path, env })
    expect(env).toEqual({ SMTP_URL: 'smtp://127.0.0.1:1025', POSTGRES_DB: 'from-shell' })
  })

  test('does nothing when the file is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'orch-env-'))
    const env: Record<string, string | undefined> = {}
    loadRootEnv({ path: join(dir, '.env'), env })
    expect(env).toEqual({})
  })

  test('skips comments and blank lines and unwraps quoted values', () => {
    const path = setup(
      [
        '# a comment',
        '',
        '  ',
        'DOUBLE="has spaces # not a comment"',
        "SINGLE='single quoted'",
        "RAW='$HOME'",
        'export EXPORTED=yes',
        'TRAILING=value # comment',
        'URL=https://example.com/#frag',
        'EMPTY=',
      ].join('\n'),
    )
    const env: Record<string, string | undefined> = {}
    loadRootEnv({ path, env })
    expect(env).toEqual({
      DOUBLE: 'has spaces # not a comment',
      SINGLE: 'single quoted',
      RAW: '$HOME',
      EXPORTED: 'yes',
      TRAILING: 'value',
      URL: 'https://example.com/#frag',
      EMPTY: '',
    })
  })
})

describe('requiredEnv', () => {
  test('returns a set value and names a missing or blank one without echoing anything', () => {
    expect(requiredEnv('HOST_PORT', { HOST_PORT: ' 4599 ' })).toBe('4599')
    expect(() => requiredEnv('HOST_PORT', {})).toThrow(/^HOST_PORT is not set/)
    expect(() => requiredEnv('HOST_PORT', { HOST_PORT: '  ' })).toThrow(/^HOST_PORT is not set/)
  })
})

describe('urlFromEnv', () => {
  test('builds a URL from host and port settings, bracketing an IPv6 address', () => {
    expect(urlFromEnv('H', 'P', { H: '127.0.0.1', P: '4599' })).toBe('http://127.0.0.1:4599')
    expect(urlFromEnv('H', 'P', { H: '::1', P: '4599' })).toBe('http://[::1]:4599')
    expect(urlFromEnv('H', 'P', { H: '[::1]', P: '4599' })).toBe('http://[::1]:4599')
  })
})
