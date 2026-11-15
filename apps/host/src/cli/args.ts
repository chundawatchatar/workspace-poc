import { SETTING_FLAGS, type SettingFlag } from '../modules/settings/settings.service'

/** A `corch` command, from its arguments. */
export type CliCommand =
  | { name: 'start' | 'restart'; flags: Partial<Record<SettingFlag, string>> }
  | { name: 'run'; flags: Partial<Record<SettingFlag, string>>; background: boolean }
  | { name: 'stop' | 'status' | 'logs' | 'terminals-stop' | 'rotate-key' | 'help' }
  | { name: 'remote'; args: string[] }

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
  logs                Print the background host's log
  terminals stop      End the terminal daemon and every shell in it
  remote <command>    Configure remote access (corch remote help lists the commands)
  rotate-key          Replace the remote access key

Options:
  --data-dir <dir>    The data folder (else CORCH_DATA_DIR, else the default)
  --port <port>       The port to listen on, on 127.0.0.1 (start, run, restart)
  --relay-url <url>   The relay server's address (start, run, restart)
  --client-url <url>  The client app's address (start, run, restart)
  --log-level <level> error, warn, info or debug (start, run, restart)`

/**
 * Reads `corch`'s arguments. A flag takes its value as the next argument or after `=`. `--data-dir` is read
 * anywhere, even among `remote`'s arguments; the setting flags only with `start`, `run` and `restart`. Null for
 * anything else: an unknown command or flag, a missing value, or a stray argument.
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
  if (name === 'stop' || name === 'status' || name === 'logs' || name === 'rotate-key') return alone({ name })
  // Bare `corch` with only flags starts the host.
  const [command, flagArgs] = name.startsWith('--') ? ['start', rest] : [name, args]
  if (command !== 'start' && command !== 'run' && command !== 'restart') return null
  const parsed = parseSettingFlags(flagArgs, command === 'run')
  if (!parsed) return null
  if (command === 'run') return { command: { name: command, ...parsed }, dataDir }
  return { command: { name: command, flags: parsed.flags }, dataDir }
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

/** The setting flags as arguments again, for the `run` that `start` spawns. */
export function settingFlagArgs(flags: Partial<Record<SettingFlag, string>>): string[] {
  return Object.entries(flags).flatMap(([flag, value]) => [flag, value])
}

function splitFlag(arg: string): [string, string | undefined] {
  if (!arg.startsWith('--')) return [arg, undefined]
  const at = arg.indexOf('=')
  return at === -1 ? [arg, undefined] : [arg.slice(0, at), arg.slice(at + 1)]
}
