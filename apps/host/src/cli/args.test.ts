import { describe, expect, test } from 'bun:test'
import { parseCliArgs, settingFlagArgs, USAGE } from './args'

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
    expect(parseCliArgs(['remote', 'devices', 'approve', 'F', '--data-dir', '/d', '--yes'])).toEqual({
      command: { name: 'remote', args: ['devices', 'approve', 'F', '--yes'] },
      dataDir: '/d',
    })
    // `corch connect` and `corch disconnect` run as their `corch remote` commands.
    expect(parseCliArgs(['connect', '--email', 'e', '--data-dir=/d', '--key', 'k'])).toEqual({
      command: { name: 'remote', args: ['connect', '--email', 'e', '--key', 'k'] },
      dataDir: '/d',
    })
    expect(parseCliArgs(['disconnect', '--yes'])?.command).toEqual({ name: 'remote', args: ['disconnect', '--yes'] })
    expect(parseCliArgs(['terminals', 'stop'])?.command).toEqual({ name: 'terminals-stop' })
    expect(parseCliArgs(['logs'])?.command).toEqual({ name: 'logs', all: false })
    expect(parseCliArgs(['logs', '--all'])?.command).toEqual({ name: 'logs', all: true })
    expect(parseCliArgs(['service', 'install', '--data-dir', '/d'])).toEqual({
      command: { name: 'service', action: 'install' },
      dataDir: '/d',
    })
    expect(parseCliArgs(['service', 'uninstall'])?.command).toEqual({ name: 'service', action: 'uninstall' })
  })

  test('reads the config subcommands', () => {
    const action = (...argv: string[]) => {
      const command = parseCliArgs(['config', ...argv])?.command
      return command?.name === 'config' ? command.action : null
    }
    expect(action('list')).toEqual({ name: 'list' })
    expect(action('path', '--data-dir', '/d')).toEqual({ name: 'path' })
    expect(action('get', 'port')).toEqual({ name: 'get', key: 'port' })
    expect(action('set', 'port', '5000')).toEqual({ name: 'set', key: 'port', value: '5000' })
    expect(action('unset', 'clientUrl')).toEqual({ name: 'unset', key: 'clientUrl' })
  })

  test('names an unknown command, so the caller can say which', () => {
    expect(parseCliArgs(['frobnicate', '--port', '1'])?.command).toEqual({ name: 'unknown', given: 'frobnicate' })
    // The host issues no access keys, so the command that replaced one is gone. Spelt in parts, so a search of the
    // code for the old name finds only what is left of it.
    const removed = ['rotate', 'key'].join('-')
    expect(parseCliArgs([removed])?.command).toEqual({ name: 'unknown', given: removed })
    expect(USAGE).not.toContain(removed)
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
      ['config', 'set', 'relayUrl', 'wss://r', '--yes'],
      ['config', 'unset', 'relayUrl', '--yes'],
      ['config', 'frob'],
      ['start', '--bogus'],
      ['start', '--port'],
      ['--data-dir'],
      ['status', '--port', '1'],
      ['start', '--background'],
      ['terminals'],
      ['stop', 'now'],
      ['service'],
      ['service', 'start'],
      ['service', 'install', 'now'],
      ['service', 'install', '--port', '1'],
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
