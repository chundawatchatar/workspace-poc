import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { defaultDataDir } from '../lib/dataDir'
import { DaemonRepository, daemonRuntimeDir } from '../modules/terminals/daemon.repository'
import { stopDaemon } from '../modules/terminals/daemon.service'
import { createHostCaller } from '../remote-cli'
import { printable } from '../remote-cli-output'
import { remoteCommand } from '../remote-command'
import { rotateKeyCommand } from '../rotate-key-command'
import { parseCliArgs, USAGE } from './args'
import { runConfig } from './config'
import { hostState, restart, start, status, stop } from './lifecycle'
import { logsCommand } from './logs'
import { run } from './run'
import { selfCommand } from './self'
import {
  flagsRefused,
  installedService,
  installService,
  restartService,
  type ServiceDeps,
  serviceDeps,
  serviceLine,
  startService,
  stopService,
  uninstallService,
} from './service'

// The packaged `corch` command. It never reads the repo's `.env` or the dev `HOST_*` and `SERVER_URL` variables:
// its data folder comes from `--data-dir`, `CORCH_DATA_DIR` or the platform default, and its settings from that
// folder's `config.json`, the `CORCH_*` variables and the setting flags.

/** The exit code for arguments that make no command. */
export const USAGE_EXIT = 2

/**
 * Runs one `corch` command. Answers its exit code, or null for `run`, whose host keeps the process alive. Tests pass
 * `service` to keep the service's unit file out of the user's own folders.
 */
export async function runCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  service: Partial<ServiceDeps> = {},
) {
  const args = parseCliArgs(argv)
  if (!args) {
    console.error(USAGE)
    return USAGE_EXIT
  }
  const { command } = args
  const dataDir = resolve(
    args.dataDir || env.CORCH_DATA_DIR || defaultDataDir({ platform: process.platform, home: homedir(), env }),
  )
  const deps = serviceDeps(dataDir, env, service)
  switch (command.name) {
    case 'help':
      console.log(USAGE)
      return 0
    case 'start':
    case 'restart': {
      const installed = installedService(deps)
      if (!installed) {
        const options = { dataDir, flags: command.flags, self: selfCommand() }
        return command.name === 'start' ? start(options) : restart(options)
      }
      const given = Object.keys(command.flags)
      if (given.length > 0) {
        deps.err(flagsRefused(given))
        return 1
      }
      return command.name === 'start' ? startService(deps, installed) : restartService(deps, installed)
    }
    case 'run':
      return run({ dataDir, flags: command.flags, background: command.background })
    case 'stop': {
      const installed = installedService(deps)
      return installed ? stopService(deps, installed) : stop(dataDir)
    }
    case 'status': {
      const code = await status(dataDir)
      deps.out(await serviceLine(installedService(deps)))
      return code
    }
    case 'service':
      return command.action === 'install' ? installService(deps) : uninstallService(deps)
    case 'unknown':
      console.error(`unknown command: ${printable(command.given)}\n${USAGE}`)
      return USAGE_EXIT
    case 'logs':
      return logsCommand(dataDir, command.all)
    case 'config': {
      const url = await runningUrl(dataDir)
      return runConfig(command.action, {
        dataDir,
        env,
        callHost: url === null ? null : createHostCaller(url),
        out: (line) => console.log(line),
        err: (line) => console.error(line),
      })
    }
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
