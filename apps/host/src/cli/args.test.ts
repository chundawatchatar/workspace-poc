import { describe, expect, test } from 'bun:test'
import { parseCliArgs } from './args'

describe('parseCliArgs', () => {
  test('reads the commands, the data folder anywhere and the setting flags', () => {
    expect(parseCliArgs([])).toEqual({ command: { name: 'start', flags: {} }, dataDir: null })
    expect(parseCliArgs(['--port', '5000', '--data-dir=/d'])).toEqual({
      command: { name: 'start', flags: { '--port': '5000' } },
      dataDir: '/d',
    })
    expect(parseCliArgs(['run', '--background', '--log-level=debug'])).toEqual({
      command: { name: 'run', flags: { '--log-level': 'debug' }, background: true },
      dataDir: null,
    })
    expect(parseCliArgs(['remote', 'link', 'k', '--data-dir', '/d', '--yes'])).toEqual({
      command: { name: 'remote', args: ['link', 'k', '--yes'] },
      dataDir: '/d',
    })
    expect(parseCliArgs(['terminals', 'stop'])?.command).toEqual({ name: 'terminals-stop' })
    expect(parseCliArgs(['logs'])?.command).toEqual({ name: 'logs', all: false })
    expect(parseCliArgs(['logs', '--all'])?.command).toEqual({ name: 'logs', all: true })
  })

  test('names an unknown command, so the caller can say which', () => {
    expect(parseCliArgs(['frobnicate', '--port', '1'])?.command).toEqual({ name: 'unknown', given: 'frobnicate' })
  })

  test('refuses an unknown command or flag, a missing value and a setting flag on a command without settings', () => {
    for (const argv of [
      ['--bogus'],
      ['logs', '--tail'],
      ['start', '--bogus'],
      ['start', '--port'],
      ['--data-dir'],
      ['status', '--port', '1'],
      ['start', '--background'],
      ['terminals'],
      ['stop', 'now'],
    ]) {
      expect([argv, parseCliArgs(argv)]).toEqual([argv, null])
    }
  })
})
