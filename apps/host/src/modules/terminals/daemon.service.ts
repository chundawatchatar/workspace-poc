import { createConnection } from 'node:net'
import { resolve } from 'node:path'
import { type AppState, listPanes } from '@orch/shared'
import {
  DAEMON_PROTOCOL,
  DaemonDecoder,
  daemonMessage,
  encodeControlFrame,
  type SessionManager,
  shellProgram,
  type TerminalSession,
} from '@orch/terminal'
import { type DaemonRecord, DaemonRepository } from './daemon.repository'
import { DaemonSession } from './daemon-session.service'
import { SharedDaemon } from './shared-daemon.service'

/**
 * Authenticates to one registered daemon and asks it to end its terminal. A record whose socket is gone is
 * stale and removed; a daemon that fails the identity check is left running, with its record kept for diagnosis.
 */
export function closeDaemon(
  repository: DaemonRepository,
  record: DaemonRecord,
): Promise<'closed' | 'stale' | 'failed'> {
  return new Promise((done) => {
    const socket = createConnection(repository.socket)
    const decoder = new DaemonDecoder()
    let verified = false
    let result: 'closed' | 'stale' | 'failed' = 'failed'
    const deadline = setTimeout(() => socket.destroy(new Error('Daemon close timed out')), 3000)
    socket.on('connect', () =>
      socket.write(
        encodeControlFrame({
          type: 'hello',
          protocol: DAEMON_PROTOCOL,
          id: record.id,
          token: record.token,
          create: false,
        }),
      ),
    )
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== 'control') continue
          const message = daemonMessage.parse(frame.value)
          if (verified || message.type === 'closed') {
            if (message.type === 'closed') result = 'closed'
            continue
          }
          if (message.type !== 'snapshot' || message.status.id !== record.id)
            throw new Error('Daemon identity mismatch')
          verified = true
          socket.write(encodeControlFrame({ type: 'close' }))
        }
      } catch (error) {
        console.error(`terminal ${record.id}:`, error)
        socket.destroy()
      }
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '')) result = 'stale'
      else console.error(`terminal ${record.id}:`, error.message)
    })
    socket.on('close', () => {
      clearTimeout(deadline)
      if (result !== 'failed') repository.remove(record.id)
      done(result)
    })
  })
}

/**
 * Reattaches every terminal in the starting layout to its daemon, then ends daemons the layout no longer has:
 * daemons outlive the layout file, so deleting it to reset the layout would otherwise leave them running unseen.
 * An unreadable layout is no proof they are orphaned, so then they are only counted.
 */
export function restoreTerminals(
  layout: { state: AppState; origin: 'file' | 'missing' | 'invalid' },
  sessions: SessionManager,
  factory: ReturnType<typeof daemonFactory>,
): Promise<void> {
  const liveIds = new Set<string>()
  for (const workspace of layout.state.workspaces) {
    for (const surface of listPanes(workspace.root).flatMap((pane) => pane.surfaces)) {
      if (surface.kind !== 'terminal') continue
      liveIds.add(surface.id)
      sessions.ensure(surface.id, workspace.cwd, 80, 24)
    }
  }
  if (layout.origin !== 'invalid') return factory.reconcile(liveIds)
  const orphans = factory.repository.list().filter((record) => !liveIds.has(record.id)).length
  if (orphans) console.warn(`layout could not be read; keeping ${orphans} terminal daemon(s) it may still refer to`)
  return Promise.resolve()
}

/** Asks the shared daemon to end every session and exit. Used by `terminals:stop`. */
export function stopDaemon(repository: DaemonRepository): Promise<'stopped' | 'absent'> {
  return new Promise((done) => {
    const socket = createConnection(repository.socket)
    socket.on('connect', () => {
      socket.end(encodeControlFrame({ type: 'stop' }))
      done('stopped')
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      done(['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '') ? 'absent' : 'stopped')
    })
  })
}

/** Creates the one persistent daemon and the terminals that attach to it. */
export function daemonFactory(hostRoot: string) {
  const repository = new DaemonRepository(hostRoot)
  const shared = new SharedDaemon(
    repository,
    [process.execPath, resolve(hostRoot, '../ptyd-bun/src/main.ts')],
    shellProgram(),
  )
  return {
    repository,
    shared,
    create: (id: string, cwd: string, cols: number, rows: number, onChange: (session: TerminalSession) => void) =>
      new DaemonSession(id, cwd, cols, rows, onChange, shared),
    /** Ends sessions whose terminal is no longer in the layout. Call it only with a layout that loaded or was absent. */
    reconcile: async (liveIds: Set<string>) => {
      const orphans = repository.list().filter((record) => !liveIds.has(record.id))
      const results = await Promise.all(orphans.map((record) => closeDaemon(repository, record)))
      const closed = results.filter((result) => result === 'closed').length
      if (closed) console.log(`closed ${closed} terminal session(s) that are no longer in the layout`)
    },
  }
}
