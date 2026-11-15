import type { DaemonCompatibility } from '@orch/shared'

// Imported by `main.ts` before it knows which program it runs, so this file imports nothing at runtime.

/**
 * The first argument that makes the host executable run the terminal daemon instead of the host. The lifecycle job
 * may rename it, but only here.
 */
export const DAEMON_SUBCOMMAND = '__daemon'

/** What a host last heard from the daemon: a status with the daemon's build, or a refusal naming its protocol. */
export type DaemonContact = { type: 'status'; build: string | undefined } | { type: 'refused'; protocol: number }

/**
 * The command that starts the terminal daemon. A packaged host is one executable, so it runs `self`, the command
 * that re-runs it, with the daemon subcommand; from source it runs `dev`, the daemon's own entry file.
 */
export function daemonCommand({ packaged, self, dev }: { packaged: boolean; self: string[]; dev: string[] }): string[] {
  return packaged ? [...self, DAEMON_SUBCOMMAND] : dev
}

/** The command a user runs to stop the daemon, so the next host start launches one that matches it. */
export function stopDaemonHint(packaged: boolean): string {
  return packaged ? 'corch terminals stop' : 'bun run terminals:stop'
}

/**
 * How the daemon last heard from relates to a host of build `build`. A refusal means another protocol; a status
 * means the same protocol, from this build or another one (a daemon from before builds were sent has none). Null
 * means nothing has been heard yet.
 */
export function daemonCompatibility(contact: DaemonContact | null, build: string): DaemonCompatibility {
  if (!contact) return null
  if (contact.type === 'refused') return 'incompatible'
  return contact.build === build ? 'current' : 'outdated'
}

/** The daemon refused a host's hello because it speaks another protocol, `protocol`. */
export class DaemonRefused extends Error {
  constructor(readonly protocol: number) {
    super(`Terminal daemon speaks protocol ${protocol}`)
  }
}
