import { createInterface } from 'node:readline'
import type { RemoteAccessEnv } from './modules/remote-access/addresses.service'
import { type CallHost, createHostCaller, runRemote } from './remote-cli'

/** Reads one line from stdin after printing `question`. Null when stdin ends first. */
export function prompt(question: string): Promise<string | null> {
  const lines = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((done) => {
    let answered = false
    lines.on('close', () => {
      if (!answered) done(null)
    })
    lines.question(question, (answer) => {
      answered = true
      lines.close()
      done(answer)
    })
  })
}

/** A caller for a host that is known not to run: every call answers that none is running. */
const noHost: CallHost = async () => null

/**
 * Runs one remote access command against the data folder `dataDir` and the host at `hostUrl`, wiring the real disk
 * and terminal to `runRemote`. A null `hostUrl` means no host is running, so the files are used directly. `env` is
 * the dev host's `SERVER_URL` and `CLIENT_URL`; `program` is the command the usage names. Answers the exit code.
 */
export async function remoteCommand(
  args: string[],
  options: { dataDir: string; hostUrl: string | null; env: RemoteAccessEnv; program: string },
): Promise<number> {
  try {
    return await runRemote(args, {
      callHost: options.hostUrl === null ? noHost : createHostCaller(options.hostUrl),
      dataDir: options.dataDir,
      env: options.env,
      prompt,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      now: Date.now,
      onInterrupt: (handler) => {
        process.on('SIGINT', handler)
        return () => process.off('SIGINT', handler)
      },
      program: options.program,
    })
  } catch (error) {
    console.error(`${options.program} failed: ${error instanceof Error ? error.message : error}`)
    return 1
  }
}
