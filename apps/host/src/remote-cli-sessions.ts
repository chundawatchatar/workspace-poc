import { formatLocalDateTime, type RemoteSession, routes } from '@orch/shared'
import type { RemoteCliDeps } from './remote-cli'
import { printable, refused } from './remote-cli-output'

// `bun run host:remote sessions`: the Sessions list of the Remote access
// setting. Sessions live only in the running host's memory, so a stopped host
// has none. Nothing here prints a device id or an account id.

export type SessionsCommand = { name: 'sessions' }

/** The command the words after `sessions` name, or null when they don't make one. */
export function parseSessionsArgs(rest: string[]): SessionsCommand | null {
  return rest.length === 0 ? { name: 'sessions' } : null
}

/** Prints the running host's sessions, one line each, newest first. */
export async function sessionsThroughHost(deps: RemoteCliDeps): Promise<number> {
  const answer = await deps.callHost(routes.remoteAccess.sessions, {})
  if (!answer?.ok) return refused(answer, deps.err)
  if (answer.data.sessions.length === 0) deps.out('No remote sessions are open')
  for (const session of answer.data.sessions) deps.out(sessionLine(session))
  return 0
}

/** With the host stopped there is nothing to list, which is not an error. */
export function sessionsFromFile(deps: RemoteCliDeps): number {
  deps.out('No host is running, so no remote sessions are open')
  return 0
}

/** One session, such as `ABCD-EFGH  account  3 sockets  since 6 Nov 2026, 12:00`. */
function sessionLine(session: RemoteSession): string {
  const credentials = session.credentials.map((credential) => credential.kind).join(', ')
  const sockets = `${session.sockets} ${session.sockets === 1 ? 'socket' : 'sockets'}`
  return `${printable(session.fingerprint)}  ${credentials}  ${sockets}  since ${formatLocalDateTime(session.startedAt)}`
}
