import { SETTING_FLAGS, type SettingFlag } from '../modules/settings/settings.service'

/** A `corch` command, from its arguments. */
export type CliCommand =
  | { name: 'start' | 'restart'; flags: Partial<Record<SettingFlag, string>> }
  | { name: 'run'; flags: Partial<Record<SettingFlag, string>>; background: boolean }
  | { name: 'stop' | 'status' | 'terminals-stop' | 'rotate-key' | 'help' }
  | { name: 'logs'; all: boolean }
  | { name: 'remote'; args: string[] }
  | { name: 'config'; action: ConfigAction }
  /** A command name `corch` doesn't have, so the caller can name it. */
  | { name: 'unknown'; given: string }

/** A `corch config` subcommand. The key is checked when it runs, so an unknown one gets the settings' own message. */
export type ConfigAction =
  | { name: 'list' | 'path' }
  | { name: 'get'; key: string }
  | { name: 'set'; key: string; value: string; yes: boolean }
  | { name: 'unset'; key: string; yes: boolean }

/** What the arguments say: the command and the data folder they name, or null when none does. */
export interface CliArgs {
  command: CliCommand
  dataDir: string | null
}

/**
 * The flag `start` passes to the `run` it spawns, so that `run` writes to `corch.log` instead of the terminal. It
 * is not in the usage: a user runs `start` for the background and `run` for the foreground.
 */
export const BACKGROUND_FLAG = '--background'

const DATA_DIR_FLAG = '--data-dir'
const SETTING_FLAG_NAMES = new Set<string>(Object.values(SETTING_FLAGS))

export const USAGE = `Usage: corch [command] [options]

Commands:
  start               Start the host in the background and print its URL (the default)
  run                 Run the host in the foreground, logging to the terminal
  stop                Stop the host; the terminal daemon and its shells keep running
  restart             Stop the host, then start it again
  status              Show whether the host runs, its URL, its pid and the terminal daemon
  logs [--all]        Print the last 200 lines of the background host's log, or all of it
  terminals stop      End the terminal daemon and every shell in it
  remote <command>    Configure remote access (corch remote help lists the commands)
  rotate-key          Replace the remote access key
  config list         Show each setting, its value and where the value comes from
  config get <key>    Print one setting's value
  config set <key> <value> [--yes]
                      Save a setting in config.json; --yes turns remote access off without asking
                      when a running host's tunnel would stay on the old relay
  config unset <key> [--yes]
                      Remove a setting from config.json, so its default applies
  config path         Print where config.json is

Options:
  --data-dir <dir>    The data folder (else CORCH_DATA_DIR, else the default)
  --port <port>       The port to listen on, on 127.0.0.1 (start, run, restart)
  --relay-url <url>   The relay server's address (start, run, restart)
  --client-url <url>  The client app's address (start, run, restart)
  --log-level <level> error, warn, info or debug (start, run, restart)

Settings: port, relayUrl, clientUrl, logLevel. A host reads them when it starts.`

/**
 * Reads `corch`'s arguments. A flag takes its value as the next argument or after `=`. `--data-dir` is read
 * anywhere, even among `remote`'s arguments; the setting flags only with `start`, `run` and `restart`. A name that
 * is no command gives `unknown`. Null for anything else: an unknown flag, a missing value, or a stray argument.
 */
export function parseCliArgs(argv: string[]): CliArgs | null {
  const taken = takeDataDir(argv)
  if (!taken) return null
  const { dataDir, rest } = taken
  const [name = 'start', ...args] = rest
  const alone = (command: CliCommand) => (args.length === 0 ? { command, dataDir } : null)
  if (name === 'remote') return { command: { name, args }, dataDir }
  if (name === 'terminals')
    return args.length === 1 && args[0] === 'stop' ? { command: { name: 'terminals-stop' }, dataDir } : null
  if (name === 'help' || name === '--help' || name === '-h') return alone({ name: 'help' })
  if (name === 'stop' || name === 'status' || name === 'rotate-key') return alone({ name })
  if (name === 'logs') {
    if (args.length === 0 || (args.length === 1 && args[0] === '--all'))
      return { command: { name, all: args.length === 1 }, dataDir }
    return null
  }
  if (name === 'config') {
    const action = parseConfigArgs(args)
    return action ? { command: { name, action }, dataDir } : null
  }
  // Bare `corch` with only flags starts the host.
  const [command, flagArgs] = name.startsWith('--') ? ['start', rest] : [name, args]
  if (command !== 'start' && command !== 'run' && command !== 'restart')
    return { command: { name: 'unknown', given: command }, dataDir }
  const parsed = parseSettingFlags(flagArgs, command === 'run')
  if (!parsed) return null
  if (command === 'run') return { command: { name: command, ...parsed }, dataDir }
  return { command: { name: command, flags: parsed.flags }, dataDir }
}

/** The `config` subcommand, or null when the arguments don't make one. `--yes` may come anywhere after the name. */
function parseConfigArgs(args: string[]): ConfigAction | null {
  const [name, ...rest] = args
  const yes = rest.includes('--yes')
  const values = rest.filter((arg) => arg !== '--yes')
  if (values.some((arg) => arg.startsWith('--'))) return null
  const [key, value] = values as [string | undefined, string | undefined]
  if ((name === 'list' || name === 'path') && rest.length === 0) return { name }
  if (name === 'get' && rest.length === 1 && key) return { name, key }
  if (name === 'set' && values.length === 2 && key && value !== undefined) return { name, key, value, yes }
  if (name === 'unset' && values.length === 1 && key) return { name, key, yes }
  return null
}

/** Takes `--data-dir` out of the arguments. Null when it has no value. */
function takeDataDir(argv: string[]): { dataDir: string | null; rest: string[] } | null {
  let dataDir: string | null = null
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const [name, inline] = splitFlag(arg)
    if (name !== DATA_DIR_FLAG) {
      rest.push(arg)
      continue
    }
    const value = inline ?? argv[++i]
    if (!value) return null
    dataDir = value
  }
  return { dataDir, rest }
}

/** The setting flags, and the background flag when `run` allows it. Null for any other argument. */
function parseSettingFlags(
  args: string[],
  allowBackground: boolean,
): { flags: Partial<Record<SettingFlag, string>>; background: boolean } | null {
  const flags: Partial<Record<SettingFlag, string>> = {}
  let background = false
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = splitFlag(args[i] as string)
    if (allowBackground && flag === BACKGROUND_FLAG && inline === undefined) {
      background = true
      continue
    }
    if (!SETTING_FLAG_NAMES.has(flag)) return null
    const value = inline ?? args[++i]
    if (value === undefined || value.startsWith('--')) return null
    flags[flag as SettingFlag] = value
  }
  return { flags, background }
}

/**
 * The setting flags as arguments again, for the `run` that `start` spawns: one `--flag=value` each, so a value can
 * never be read as a flag of its own.
 */
export function settingFlagArgs(flags: Partial<Record<SettingFlag, string>>): string[] {
  return Object.entries(flags).map(([flag, value]) => `${flag}=${value}`)
}

function splitFlag(arg: string): [string, string | undefined] {
  if (!arg.startsWith('--')) return [arg, undefined]
  const at = arg.indexOf('=')
  return at === -1 ? [arg, undefined] : [arg.slice(0, at), arg.slice(at + 1)]
}
