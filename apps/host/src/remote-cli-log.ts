import { type AuditLogEntry, formatLocalDateTime, routes } from '@orch/shared'
import { AuditLogRepository, auditLogPath } from './modules/remote-access/audit-log.repository'
import { AuditLogService } from './modules/remote-access/audit-log.service'
import type { RemoteCliDeps } from './remote-cli'
import { messageOf, printable, refused } from './remote-cli-output'

// `bun run host:remote log`: the Recent activity list of the Remote access
// setting. With the host running it asks the host, otherwise it reads
// `remote-audit.jsonl` itself, merged and ordered the same way.

/** Prints the newest audit log entries from the running host. */
export async function logThroughHost(deps: RemoteCliDeps): Promise<number> {
  const answer = await deps.callHost(routes.remoteAccess.auditLog, {})
  if (!answer?.ok) return refused(answer, deps.err)
  printEntries(answer.data.entries, deps.out)
  return 0
}

/** Prints the newest audit log entries from the file, with the host stopped. */
export function logFromFile(deps: RemoteCliDeps): number {
  let entries: AuditLogEntry[]
  try {
    entries = new AuditLogService(new AuditLogRepository(auditLogPath(deps.dataDir))).recent()
  } catch (error) {
    deps.err(messageOf(error))
    return 1
  }
  printEntries(entries, deps.out)
  return 0
}

function printEntries(entries: AuditLogEntry[], out: (line: string) => void) {
  if (entries.length === 0) out('No remote access recorded')
  for (const entry of entries) out(entryLine(entry))
}

/** One entry as a line: when it opened or was refused, then who or why. Every value from the file is made printable. */
function entryLine(entry: AuditLogEntry): string {
  if (entry.kind === 'refused') {
    const fingerprint = entry.fingerprint ? `  ${printable(entry.fingerprint)}` : ''
    return `${formatLocalDateTime(entry.at)}  refused  ${entry.reason}${fingerprint}`
  }
  const closed = entry.closedAt ? `closed ${formatLocalDateTime(entry.closedAt)}` : 'still open or not recorded'
  return `${formatLocalDateTime(entry.openedAt)}  opened   account  ${printable(entry.fingerprint)}  ${closed}`
}
