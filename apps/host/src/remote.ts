import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { HOST_PORT } from '@orch/shared'
import { createHostCaller, runRemote } from './remote-cli'

// `bun run host:remote <command>`: configures remote access from a terminal.
// The logic is in `remote-cli.ts`; this file only wires the real host, disk,
// environment and terminal to it.

/** Reads one line from stdin after printing `question`. Null when stdin ends first. */
function prompt(question: string): Promise<string | null> {
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

try {
  process.exitCode = await runRemote(process.argv.slice(2), {
    callHost: createHostCaller(`http://127.0.0.1:${HOST_PORT}`),
    hostRoot: resolve(import.meta.dir, '..'),
    env: { SERVER_URL: process.env.SERVER_URL, CLIENT_URL: process.env.CLIENT_URL },
    prompt,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
} catch (error) {
  console.error(`host:remote failed: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
}
