import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { defaultDataDir } from '../lib/dataDir'
import { DaemonRepository, daemonRuntimeDir } from '../modules/terminals/daemon.repository'
import { stopDaemon } from '../modules/terminals/daemon.service'
import { remoteCommand } from '../remote-command'
import { rotateKeyCommand } from '../rotate-key-command'
import { parseCliArgs, USAGE } from './args'
import { hostState, restart, start, status, stop } from './lifecycle'
import { logsCommand } from './logs'
import { run } from './run'
import { selfCommand } from './self'

// The packaged `corch` command. It never reads the repo's `.env` or the dev `HOST_*` and `SERVER_URL` variables:
// its data folder comes from `--data-dir`, `CORCH_DATA_DIR` or the platform default, and its settings from that
// folder's `config.json`, the `CORCH_*` variables and the setting flags.

/** The exit code for arguments that make no command. */
export const USAGE_EXIT = 2

/** Runs one `corch` command. Answers its exit code, or null for `run`, whose host keeps the process alive. */
export async function runCli(argv: string[], env: Record<string, string | undefined> = process.env) {
  const args = parseCliArgs(argv)
  if (!args) {
    console.error(USAGE)
    return USAGE_EXIT
  }
  const { command } = args
  const dataDir = resolve(
    args.dataDir || env.CORCH_DATA_DIR || defaultDataDir({ platform: process.platform, home: homedir(), env }),
  )
  switch (command.name) {
    case 'help':
      console.log(USAGE)
      return 0
    case 'start':
      return start({ dataDir, flags: command.flags, self: selfCommand() })
    case 'restart':
      return restart({ dataDir, flags: command.flags, self: selfCommand() })
    case 'run':
      return run({ dataDir, flags: command.flags, background: command.background })
    case 'stop':
      return stop(dataDir)
    case 'status':
      return status(dataDir)
    case 'logs':
      return logsCommand(dataDir)
    case 'terminals-stop':
      return terminalsStop(dataDir)
    case 'remote':
      return remoteCommand(command.args, {
        dataDir,
        hostUrl: await runningUrl(dataDir),
        env: {},
        program: 'corch remote',
      })
    case 'rotate-key':
      return rotateKeyCommand({ dataDir, hostUrl: await runningUrl(dataDir), env: {}, settingsEnv: env })
  }
}

/** The URL of the host the run file names, once it answers with its instance id. Null when none runs. */
async function runningUrl(dataDir: string): Promise<string | null> {
  const state = await hostState(dataDir)
  return state.kind === 'running' ? state.run.url : null
}

/**
 * `corch terminals stop`: ends this data folder's terminal daemon and every shell in it. Refused while a host runs,
 * since it would start the daemon again for its open tabs. Records are kept, so the next host reopens the shells
 * in their folders.
 */
async function terminalsStop(dataDir: string): Promise<number> {
  const state = await hostState(dataDir)
  if (state.kind !== 'none') {
    const which = state.kind === 'running' ? `at ${state.run.url} (pid ${state.run.pid})` : 'starting'
    console.error(`A host is ${which}. Run corch stop first: it would start the terminal daemon again.`)
    return 1
  }
  const repository = new DaemonRepository({ dataDir, runtime: daemonRuntimeDir(dataDir, process.getuid?.() ?? 'user') })
  const result = await stopDaemon(repository)
  console.log(
    result === 'stopped' ? 'Stopped the terminal daemon and every shell in it' : 'No terminal daemon was running',
  )
  return 0
}
