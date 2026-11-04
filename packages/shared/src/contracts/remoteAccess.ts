import { z } from 'zod'
import { defineContract } from './contract'
import { enrollmentKeySchema } from './serverMachines'

/**
 * Where the tunnel to the server stands: `connecting` while it dials or waits
 * for `welcome`, `reconnecting` while it waits to dial again, `stopped` once
 * the server refused it for good, and `off` when remote access is off.
 */
export const tunnelState = z.enum(['off', 'connecting', 'connected', 'reconnecting', 'stopped'])
export type TunnelState = z.infer<typeof tunnelState>

/** An account as the server shows it to a machine: its name, and only the first character of the email's local part. */
export const linkAccount = z.object({ name: z.string(), maskedEmail: z.string() })
export type LinkAccount = z.infer<typeof linkAccount>

/** The account this machine is linked to. `serverUrl` is the server it was linked through, `linkedAt` an ISO string. */
export const linkedAccount = linkAccount.extend({ serverUrl: z.string(), linkedAt: z.iso.datetime() })
export type LinkedAccount = z.infer<typeof linkedAccount>

export const remoteAccessStatus = z.object({
  /** True while remote access is on, whether the setting or `SERVER_URL` turned it on. */
  enabled: z.boolean(),
  /** The server address in use: `SERVER_URL`, else the saved one, else the built-in default. */
  serverUrl: z.string(),
  /** True when the server address in use is the built-in default. */
  serverUrlIsDefault: z.boolean(),
  /** The client address for connect links: `CLIENT_URL`, else the saved one. Null means it is derived from `serverUrl`. */
  clientUrl: z.string().nullable(),
  /** True when `SERVER_URL` sets the server address, so the saved one is not used. */
  serverUrlFromEnv: z.boolean(),
  /** True when `CLIENT_URL` sets the client address, so the saved one is not used. */
  clientUrlFromEnv: z.boolean(),
  /** The id the server knows this machine by. Null until a machine secret exists. */
  machineId: z.string().nullable(),
  tunnel: tunnelState,
  /** The account this machine is linked to. Null means none. */
  linkedAccount: linkedAccount.nullable(),
})
export type RemoteAccessStatus = z.infer<typeof remoteAccessStatus>

export const updateRemoteAccessBody = z.object({
  enabled: z.boolean(),
  /** `wss://<host>`, or `ws://` on a loopback host. Empty means the built-in default. */
  serverUrl: z.string(),
  /** An `http(s)://` address. Null or empty means connect links use the one derived from `serverUrl`. */
  clientUrl: z.string().nullable(),
})
export type UpdateRemoteAccessBody = z.infer<typeof updateRemoteAccessBody>

export const previewLinkBody = z.strictObject({ key: enrollmentKeySchema })
export type PreviewLinkBody = z.infer<typeof previewLinkBody>

/**
 * What the user checks before a key is used. `serverUrl` is the host's own
 * address in use, never anything from the key.
 */
export const previewLinkResponse = z.object({
  serverUrl: z.string(),
  serverUrlIsDefault: z.boolean(),
  account: linkAccount,
  fingerprint: z.string(),
  /** An ISO string. */
  expiresAt: z.iso.datetime(),
})
export type PreviewLinkResponse = z.infer<typeof previewLinkResponse>

/** `serverUrl` is the address the user confirmed; the host refuses the link when it is no longer the one in use. */
export const linkBody = z.strictObject({ key: enrollmentKeySchema, serverUrl: z.string() })
export type LinkBody = z.infer<typeof linkBody>

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
  previewLink: {
    method: 'POST',
    path: '/api/remote-access/link/preview',
    description:
      'Asks the server over the tunnel which account an enrollment key belongs to, without using it. Needs a connected tunnel and no linked account. Local callers only.',
    input: previewLinkBody,
    output: previewLinkResponse,
  },
  link: {
    method: 'POST',
    path: '/api/remote-access/link',
    description:
      'Redeems an enrollment key over the tunnel and remembers the account. A `serverUrl` other than the one in use gets a 409. Local callers only.',
    input: linkBody,
    output: remoteAccessStatus,
  },
  unlink: {
    method: 'POST',
    path: '/api/remote-access/unlink',
    description: 'Forgets the linked account on this machine. The server still lists the machine. Local callers only.',
    input: z.strictObject({}),
    output: remoteAccessStatus,
  },
})
