import { z } from 'zod'
import { defineContract } from './contract'
import { machineKeyResponse } from './machineKey'

export const healthResponse = z.object({ ok: z.boolean() })

export const instanceResponse = z.object({
  /** A random id the host process picks when it starts, so a command can check it is talking to that process. */
  instanceId: z.string(),
})

export const daemonResponse = z.object({
  /** How long the terminal daemon has been running. Null means it is not known to be up. */
  uptimeMs: z.number().int().nonnegative().nullable(),
  /** Terminals whose shell is still running. */
  liveTerminals: z.number().int().nonnegative(),
  /**
   * How the daemon last heard from relates to this host: `current` runs this host's build, `outdated` another build
   * of the same protocol (its terminals work), `incompatible` another protocol (its shells run, but none attach).
   * Null means no daemon has been heard from.
   */
  compatibility: z.enum(['current', 'outdated', 'incompatible']).nullable(),
  /** The protocol the daemon last heard from speaks. Null means none has been heard from. */
  daemonProtocol: z.number().int().nullable(),
  /** The command that stops the daemon, so a new one replaces it. It ends the daemon's shells. */
  stopCommand: z.string(),
})
export type DaemonReport = z.infer<typeof daemonResponse>
/** How a daemon's build and protocol relate to the host's; null means no daemon has been heard from. */
export type DaemonCompatibility = DaemonReport['compatibility']

export const systemContract = defineContract({
  health: {
    method: 'GET',
    path: '/api/health',
    description: 'Tells the web app the host is up.',
    input: z.object({}),
    output: healthResponse,
  },
  daemon: {
    method: 'GET',
    path: '/api/daemon',
    description: 'Reports the terminal daemon: its uptime, its live terminals and whether it matches this host.',
    input: z.object({}),
    output: daemonResponse,
  },
  instance: {
    method: 'GET',
    path: '/api/instance',
    description:
      'Answers the id this host process picked at start, which `corch` checks before it signals the process. Local only.',
    input: z.object({}),
    output: instanceResponse,
  },
  machineKey: {
    method: 'GET',
    path: '/api/machine-key',
    description:
      "Answers the machine's Ed25519 public key, never its private key, which a browser checks against the machine id and pins.",
    input: z.object({}),
    output: machineKeyResponse,
  },
})
