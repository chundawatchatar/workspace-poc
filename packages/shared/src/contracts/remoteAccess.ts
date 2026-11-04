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

/** A device id: the base64url SHA-256 of the device's canonical public JWK. */
export const deviceId = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

/** A browser that offered a valid relay ticket and device proof but isn't approved yet. `firstSeenAt` is an ISO string. */
export const pendingDevice = z.object({ id: deviceId, fingerprint: z.string(), firstSeenAt: z.iso.datetime() })
export type PendingDevice = z.infer<typeof pendingDevice>

/** A browser the owner approved on this machine. `approvedAt` is an ISO string. */
export const approvedDevice = z.object({ id: deviceId, fingerprint: z.string(), approvedAt: z.iso.datetime() })
export type ApprovedDevice = z.infer<typeof approvedDevice>

/** The devices that may open this machine through the linked account, and those waiting for approval, newest first. */
export const devicesResponse = z.object({ pending: z.array(pendingDevice), approved: z.array(approvedDevice) })
export type DevicesResponse = z.infer<typeof devicesResponse>

export const deviceBody = z.strictObject({ id: deviceId })
export type DeviceBody = z.infer<typeof deviceBody>

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
  devices: {
    method: 'GET',
    path: '/api/remote-access/devices',
    description:
      'Lists the browsers approved to open this machine through the linked account, and those waiting. Local callers only.',
    input: z.object({}),
    output: devicesResponse,
  },
  approveDevice: {
    method: 'POST',
    path: '/api/remote-access/devices/approve',
    description: 'Approves a waiting browser. An id that is not waiting or approved gets a 404. Local callers only.',
    input: deviceBody,
    output: devicesResponse,
  },
  removeDevice: {
    method: 'POST',
    path: '/api/remote-access/devices/remove',
    description: 'Dismisses a waiting browser, or revokes an approved one and closes its sockets. Local callers only.',
    input: deviceBody,
    output: devicesResponse,
  },
})
