import { readlinkSync } from 'node:fs'
import type { ProcessInfo } from '@orch/shared'

/** One line of `ps`. */
export interface PsRow {
  pid: number
  /** The process group it belongs to. A pipeline's commands share one, named after the first command's pid. */
  pgid: number
  /** The process group in control of the process's terminal, or -1/0 when it has none. */
  tpgid: number
  /** Seconds since it started. */
  elapsed: number
  command: string
}

/** What a shell's terminal is doing: the foreground program, if any, and its working directory. */
export interface Foreground {
  process: Omit<ProcessInfo, 'startedAt'> & { elapsed: number }
  /** False when the shell itself is in the foreground, waiting at its prompt. */
  busy: boolean
}

/** Parses `ps`'s elapsed time, `[[dd-]hh:]mm:ss`, into seconds. */
export function parseElapsed(text: string): number {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text]
  const parts = clock.split(':').map(Number)
  while (parts.length < 3) parts.unshift(0)
  const [hours, minutes, seconds] = parts
  return ((Number(days) * 24 + hours) * 60 + minutes) * 60 + seconds
}

/** Parses the output of `ps -A -o pid=,pgid=,tpgid=,etime=,args=`. */
export function parsePs(output: string): Map<number, PsRow> {
  const rows = new Map<number, PsRow>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    rows.set(pid, {
      pid,
      pgid: Number(match[2]),
      tpgid: Number(match[3]),
      elapsed: parseElapsed(match[4]),
      command: match[5].trim(),
    })
  }
  return rows
}

/**
 * A program's name from its command line. It reads the first word rather than
 * the executable, because tools like Claude Code run on node but rename their
 * process. A login shell's leading `-` is dropped.
 */
export function programName(command: string): string {
  const first = command.split(' ')[0] ?? ''
  return (first.split('/').pop() ?? first).replace(/^-/, '')
}

/** The program in the foreground of each shell's terminal, keyed by the shell's pid. */
export function findForeground(rows: Map<number, PsRow>, shellPids: number[]): Map<number, Foreground> {
  const groups = new Map<number, PsRow[]>()
  for (const row of rows.values()) groups.set(row.pgid, [...(groups.get(row.pgid) ?? []), row])

  const found = new Map<number, Foreground>()
  for (const shellPid of shellPids) {
    const shell = rows.get(shellPid)
    if (!shell) continue
    // The terminal's foreground group is the job the shell started, or the shell's own group when it is idle.
    const members = shell.tpgid > 0 && shell.tpgid !== shell.pgid ? (groups.get(shell.tpgid) ?? []) : []
    // The group is named after its first command, which may have exited while the rest of a pipeline runs on
    // (`cat log | less`). Then the newest member stands in, usually the pipeline's last stage.
    const job =
      members.find((member) => member.pid === shell.tpgid) ??
      members.reduce<PsRow | undefined>(
        (newest, member) => (newest && newest.pid > member.pid ? newest : member),
        undefined,
      )
    const shown = job ?? shell
    found.set(shellPid, {
      process: { pid: shown.pid, name: programName(shown.command), command: shown.command, elapsed: shown.elapsed },
      busy: job !== undefined,
    })
  }
  return found
}

async function run(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { stdout: 'pipe', stderr: 'ignore' })
  const output = await new Response(proc.stdout).text()
  await proc.exited
  return output
}

/** Working directories by pid. `lsof` on macOS, `/proc` on Linux. Missing ones are left out. */
async function workingDirs(pids: number[]): Promise<Map<number, string>> {
  const dirs = new Map<number, string>()
  if (pids.length === 0) return dirs
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        dirs.set(pid, readlinkSync(`/proc/${pid}/cwd`))
      } catch {}
    }
    return dirs
  }
  // `-F pn` prints `p<pid>` then `n<path>` for each process.
  const output = await run(['lsof', '-a', '-d', 'cwd', '-F', 'pn', '-p', pids.join(',')])
  let pid = 0
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) dirs.set(pid, line.slice(1))
  }
  return dirs
}

/** Looks up the foreground program and working directory of each shell, with one `ps` and one `lsof` call. */
export async function inspectShells(shellPids: number[]): Promise<Map<number, Foreground & { cwd: string | null }>> {
  const rows = parsePs(await run(['ps', '-A', '-o', 'pid=,pgid=,tpgid=,etime=,args=']))
  const foreground = findForeground(rows, shellPids)
  const dirs = await workingDirs([...foreground.values()].map((f) => f.process.pid))
  return new Map([...foreground].map(([pid, f]) => [pid, { ...f, cwd: dirs.get(f.process.pid) ?? null }]))
}
