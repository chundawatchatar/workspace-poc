import { describe, expect, test } from 'bun:test'
import { parseCliArgs, settingFlagArgs } from './args'

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

  test('reads the config subcommands, with --yes anywhere after the name', () => {
    const action = (...argv: string[]) => {
      const command = parseCliArgs(['config', ...argv])?.command
      return command?.name === 'config' ? command.action : null
    }
    expect(action('list')).toEqual({ name: 'list' })
    expect(action('path', '--data-dir', '/d')).toEqual({ name: 'path' })
    expect(action('get', 'port')).toEqual({ name: 'get', key: 'port' })
    expect(action('set', 'port', '5000')).toEqual({ name: 'set', key: 'port', value: '5000', yes: false })
    expect(action('set', '--yes', 'relayUrl', 'wss://r')).toEqual({
      name: 'set',
      key: 'relayUrl',
      value: 'wss://r',
      yes: true,
    })
    expect(action('unset', 'clientUrl', '--yes')).toEqual({ name: 'unset', key: 'clientUrl', yes: true })
  })

  test('names an unknown command, so the caller can say which', () => {
    expect(parseCliArgs(['frobnicate', '--port', '1'])?.command).toEqual({ name: 'unknown', given: 'frobnicate' })
  })

  test('refuses an unknown command or flag, a missing value and a setting flag on a command without settings', () => {
    for (const argv of [
      ['--bogus'],
      ['logs', '--tail'],
      ['config'],
      ['config', 'list', 'port'],
      ['config', 'get'],
      ['config', 'set', 'port'],
      ['config', 'set', 'port', '5000', '--port', '1'],
      ['config', 'unset', 'port', 'x'],
      ['config', 'frob'],
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

describe('settingFlagArgs', () => {
  test('passes one --flag=value argument per flag, which parseCliArgs reads back', () => {
    const flags = { '--port': '4700', '--relay-url': 'wss://r.example/?a=b' } as const
    const args = settingFlagArgs(flags)
    expect(args).toEqual(['--port=4700', '--relay-url=wss://r.example/?a=b'])
    expect(parseCliArgs(['run', '--background', '--data-dir', '/x', ...args])).toEqual({
      command: { name: 'run', flags, background: true },
      dataDir: '/x',
    })
  })
})
