import { z } from 'zod'
import { defineContract } from './contract'

/**
 * Where the tunnel to the server stands: `connecting` while it dials or waits
 * for `welcome`, `reconnecting` while it waits to dial again, `stopped` once
 * the server refused it for good, and `off` when remote access is off.
 */
export const tunnelState = z.enum(['off', 'connecting', 'connected', 'reconnecting', 'stopped'])
export type TunnelState = z.infer<typeof tunnelState>

export const remoteAccessStatus = z.object({
  /** True while remote access is on, whether the setting or `SERVER_URL` turned it on. */
  enabled: z.boolean(),
  /** The server address in use: `SERVER_URL`, else the saved one. Null means none is known. */
  serverUrl: z.string().nullable(),
  /** The client address for connect links: `CLIENT_URL`, else the saved one. Null means it is derived from `serverUrl`. */
  clientUrl: z.string().nullable(),
  /** True when `SERVER_URL` sets the server address, so the saved one is not used. */
  serverUrlFromEnv: z.boolean(),
  /** True when `CLIENT_URL` sets the client address, so the saved one is not used. */
  clientUrlFromEnv: z.boolean(),
  /** The id the server knows this machine by. Null until a machine secret exists. */
  machineId: z.string().nullable(),
  tunnel: tunnelState,
})
export type RemoteAccessStatus = z.infer<typeof remoteAccessStatus>

export const updateRemoteAccessBody = z.object({
  enabled: z.boolean(),
  /** `wss://<host>`, or `ws://` on a loopback host. May be empty while remote access is off. */
  serverUrl: z.string(),
  /** An `http(s)://` address. Null or empty means connect links use the one derived from `serverUrl`. */
  clientUrl: z.string().nullable(),
})
export type UpdateRemoteAccessBody = z.infer<typeof updateRemoteAccessBody>

export const remoteAccessContract = defineContract({
  status: {
    method: 'GET',
    path: '/api/remote-access/status',
    description: 'Reports the remote access setting and the state of the tunnel. Local callers only.',
    input: z.object({}),
    output: remoteAccessStatus,
  },
  update: {
    method: 'POST',
    path: '/api/remote-access/settings',
    description:
      'Saves the remote access setting and opens, moves or closes the tunnel to match. An address the host refuses gets a 400. Local callers only.',
    input: updateRemoteAccessBody,
    output: remoteAccessStatus,
  },
})
