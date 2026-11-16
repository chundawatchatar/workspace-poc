import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTING_ENV, SETTING_FLAGS, SETTING_KEYS, SETTINGS_DEFAULTS } from '../modules/settings/settings.service'
import { USAGE } from './args'

// The user guide is written by hand, so these checks keep it from drifting away from the usage and the settings.

const guide = readFileSync(join(import.meta.dir, '../../../../docs/corch.md'), 'utf8')

/** The usage's entries in one section, such as `config set <key> <value> [--yes]`, without their descriptions. */
function entries(section: string): string[] {
  const lines = USAGE.split(`${section}:\n`)[1]?.split('\n\n')[0]?.split('\n') ?? []
  return lines.filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim().split(/ {2,}/)[0] as string)
}

describe('docs/corch.md', () => {
  test('names every command and option of the usage, with its arguments', () => {
    const commands = entries('Commands')
    // An option's description can follow it after a single space, so only `--name <value>` is taken.
    const options = entries('Options').map((entry) => /^--[a-z-]+ <[a-z]+>/.exec(entry)?.[0])
    expect(commands.length).toBeGreaterThan(10)
    expect(options.length).toBe(5)
    for (const entry of commands) {
      // `logs [--all]` is documented as `corch logs` and `corch logs --all`.
      const command = entry.replace(/ \[[^\]]+\]/g, '')
      expect({ entry, documented: guide.includes(`corch ${command}`) }).toEqual({ entry, documented: true })
      for (const [, flag] of entry.matchAll(/\[(--[a-z-]+)\]/g)) {
        expect({ entry, flag, documented: guide.includes(flag as string) }).toEqual({ entry, flag, documented: true })
      }
    }
    for (const option of options) {
      expect({ option, documented: guide.includes(`\`${option}\``) }).toEqual({ option, documented: true })
    }
  })

  test('lists every setting with its default, flag and variable', () => {
    const defaults: Record<string, string> = {
      port: String(SETTINGS_DEFAULTS.port),
      relayUrl: SETTINGS_DEFAULTS.relayUrl,
      clientUrl: 'Derived from `relayUrl`',
      logLevel: SETTINGS_DEFAULTS.logLevel,
    }
    for (const key of SETTING_KEYS) {
      const row = guide.split('\n').find((line) => line.startsWith(`| \`${key}\` |`))
      const cells = row?.split('|').map((cell) => cell.trim())
      expect({ key, cells: cells?.slice(1, 5) }).toEqual({
        key,
        cells: [
          `\`${key}\``,
          key === 'clientUrl' ? (defaults[key] as string) : `\`${defaults[key]}\``,
          `\`${SETTING_FLAGS[key]}\``,
          `\`${SETTING_ENV[key]}\``,
        ],
      })
    }
  })
})
