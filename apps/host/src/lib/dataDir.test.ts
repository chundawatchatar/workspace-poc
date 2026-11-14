import { describe, expect, test } from 'bun:test'
import { defaultDataDir } from './dataDir'

const home = '/home/ana'

describe('defaultDataDir', () => {
  test('is ~/.corch on macOS', () => {
    expect(defaultDataDir({ platform: 'darwin', home: '/Users/ana', env: { XDG_DATA_HOME: '/x' } })).toBe(
      '/Users/ana/.corch',
    )
  })

  test('is $XDG_DATA_HOME/corch on Linux', () => {
    expect(defaultDataDir({ platform: 'linux', home, env: { XDG_DATA_HOME: '/x' } })).toBe('/x/corch')
  })

  test('falls back to ~/.local/share/corch on Linux when XDG_DATA_HOME is unset, blank or relative', () => {
    for (const env of [{}, { XDG_DATA_HOME: '' }, { XDG_DATA_HOME: '  ' }, { XDG_DATA_HOME: 'data' }])
      expect(defaultDataDir({ platform: 'linux', home, env })).toBe('/home/ana/.local/share/corch')
  })

  test('refuses any other platform, naming it', () => {
    expect(() => defaultDataDir({ platform: 'win32', home, env: {} })).toThrow('win32')
  })
})
