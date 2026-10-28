import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { daemonBuild, type daemonStatus, shellEnv } from '@orch/terminal'
import type { z } from 'zod'
import type { DaemonRepository } from './daemon.repository'

/**
 * One daemon for every terminal of this host. It owns each session's shell and
 * screen so they outlive the host, while sharing one Bun runtime between them.
 */
export class SharedDaemon {
  private starting: Promise<void> | null = null
  /** The build of the daemon code on disk, which a newly started daemon runs. */
  private readonly build: string
  /** Daemon incarnations already reported as running other code, so each is reported once. */
  private readonly reported = new Set<string>()
  private lastStartedAt: number | null = null

  constructor(
    readonly repository: DaemonRepository,
    private readonly command: string[],
    private readonly shell: string,
  ) {
    this.build = daemonBuild(command[command.length - 1])
  }

  /** When the daemon last heard from started, in epoch milliseconds. Null until a status carried one. */
  get startedAt(): number | null {
    return this.lastStartedAt
  }

  /** Takes in the first status of a connection: remembers when that daemon started and checks its build. */
  heard(status: z.infer<typeof daemonStatus>) {
    this.lastStartedAt = status.startedAt ?? null
    this.checkBuild(status)
  }

  /**
   * Warns when the daemon runs code other than what is on disk. It never reloads, so a fix made since it
   * started (or a branch switch) does not reach the terminals it owns until it is stopped and started again.
   */
  private checkBuild(status: z.infer<typeof daemonStatus>) {
    if (status.build === this.build || this.reported.has(status.instance)) return
    this.reported.add(status.instance)
    console.warn(
      `terminal daemon (pid ${status.daemonPid}) runs ${status.build ? 'different' : 'older'} code than this host. ` +
        'Its terminals keep working, but changes to the daemon reach them only after a restart: stop `bun run dev`, ' +
        'then run `bun run terminals:stop` (this ends its shells).',
    )
  }

  /**
   * Starts the daemon if its socket is not answering. Concurrent callers share
   * one attempt, and a daemon that has since exited is started again rather than
   * trusted because it was up once.
   */
  async ensureStarted(): Promise<void> {
    if (await this.ping()) return
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  private async start() {
    this.launch()
    for (let attempt = 0; attempt < 100; attempt++) {
      await Bun.sleep(50)
      if (await this.ping()) return
    }
    throw new Error('Terminal daemon did not start; inspect its log in the runtime folder')
  }

  // `Bun.connect` refuses a probe without data handlers, so this uses `node:net` like `stopDaemon`.
  private ping(): Promise<boolean> {
    return new Promise((done) => {
      const socket = createConnection(this.repository.socket)
      socket.on('connect', () => {
        socket.end()
        done(true)
      })
      socket.on('error', () => done(false))
    })
  }

  private launch() {
    const log = openSync(join(this.repository.runtime, 'host.log'), 'a', 0o600)
    try {
      const [program, ...prefix] = this.command
      const child = spawn(program, [...prefix, '--socket', this.repository.socket, '--shell', this.shell], {
        detached: true,
        stdio: ['ignore', log, log],
        env: shellEnv(process.env),
      })
      child.on('error', (error) => console.error('launching terminal daemon failed', error))
      child.unref()
    } finally {
      closeSync(log)
    }
  }
}
