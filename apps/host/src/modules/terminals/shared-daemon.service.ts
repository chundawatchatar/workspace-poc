import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { DaemonCompatibility } from '@orch/shared'
import { DAEMON_PROTOCOL, type daemonStatus, shellEnv } from '@orch/terminal'
import type { z } from 'zod'
import type { DaemonRepository } from './daemon.repository'
import { type DaemonContact, daemonCompatibility } from './daemon-build'

/**
 * One daemon for every terminal of this host. It owns each session's shell and
 * screen so they outlive the host, while sharing one Bun runtime between them.
 */
export class SharedDaemon {
  private starting: Promise<void> | null = null
  /** What the host last heard from the daemon, which decides its compatibility. */
  private contact: DaemonContact | null = null
  private daemonProtocol: number | null = null
  /** The state last logged, with the protocol for an incompatible daemon, so each change is logged once. */
  private logged: string | null = null
  private lastStartedAt: number | null = null
  readonly repository: DaemonRepository
  private readonly command: string[]
  /** This host's build. A daemon it starts runs the same one. */
  private readonly build: string
  /** The command that stops the daemon, named in every warning about it. */
  readonly stopHint: string
  private readonly shell: string

  constructor(options: {
    repository: DaemonRepository
    command: string[]
    build: string
    stopHint: string
    shell: string
  }) {
    this.repository = options.repository
    this.command = options.command
    this.build = options.build
    this.stopHint = options.stopHint
    this.shell = options.shell
  }

  /** When the daemon last heard from started, in epoch milliseconds. Null until a status carried one. */
  get startedAt(): number | null {
    return this.lastStartedAt
  }

  /** How the daemon last heard from relates to this host; null until one was heard. */
  get compatibility(): DaemonCompatibility {
    return daemonCompatibility(this.contact, this.build)
  }

  /** The daemon's state for `/api/daemon`. */
  report() {
    return {
      startedAt: this.lastStartedAt,
      compatibility: this.compatibility,
      daemonProtocol: this.daemonProtocol,
      stopCommand: this.stopHint,
    }
  }

  /** Takes in the first status of a connection: remembers when that daemon started and checks its build. */
  heard(status: z.infer<typeof daemonStatus>) {
    this.lastStartedAt = status.startedAt ?? null
    this.contact = { type: 'status', build: status.build }
    this.daemonProtocol = status.protocol
    this.logChange(status)
  }

  /** Takes in a daemon's refusal: it speaks `protocol`, so none of its terminals can attach to this host. */
  refused(protocol: number) {
    this.contact = { type: 'refused', protocol }
    this.daemonProtocol = protocol
    this.logChange(null)
  }

  /**
   * Logs one line each time the compatibility changes. Neither an old build nor another protocol ever ends the
   * daemon: it never reloads, so only the user can replace it, and that ends its shells.
   */
  private logChange(status: z.infer<typeof daemonStatus> | null) {
    const state = this.compatibility
    const key = state === 'incompatible' ? `${state}:${this.daemonProtocol}` : state
    if (key === this.logged) return
    const first = this.logged === null
    this.logged = key
    if (state === 'current') {
      if (!first) console.log(`terminal daemon (pid ${status?.daemonPid}) runs this host's build`)
    } else if (state === 'outdated') {
      console.warn(
        `terminal daemon (pid ${status?.daemonPid}) runs ${status?.build ? 'different' : 'older'} code than this ` +
          'host. Its terminals keep working, but changes to the daemon reach them only after it is replaced: stop ' +
          `the host, then run \`${this.stopHint}\` (this ends its shells).`,
      )
    } else if (state === 'incompatible') {
      console.warn(
        `terminal daemon speaks protocol ${this.daemonProtocol}, this host speaks ${DAEMON_PROTOCOL}, so no terminal ` +
          'can attach to it. Its shells are still running. To replace it, stop the host, then run ' +
          `\`${this.stopHint}\` (this ends its shells).`,
      )
    }
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
