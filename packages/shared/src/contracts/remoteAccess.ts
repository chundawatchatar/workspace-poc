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
  /** True while remote access is on, whether the setting or the dev host's `SERVER_URL` turned it on. */
  enabled: z.boolean(),
  /** The server address in use since the host started: a flag or the environment, else the saved one, else the default. */
  serverUrl: z.string(),
  /** True when the server address in use is the built-in default. */
  serverUrlIsDefault: z.boolean(),
  /** The client address for connect links in use. Null means it is derived from `serverUrl`. */
  clientUrl: z.string().nullable(),
  /** The flag or environment variable that sets the server address, such as `SERVER_URL`. Null means none does. */
  serverUrlSetBy: z.string().nullable(),
  /** The flag or environment variable that sets the client address, such as `CLIENT_URL`. Null means none does. */
  clientUrlSetBy: z.string().nullable(),
  /** The server address saved in the host's settings file. Null means none is saved, so the default is used. */
  savedServerUrl: z.string().nullable(),
  /** The client address saved in the host's settings file. Null means none is saved, so it is derived. */
  savedClientUrl: z.string().nullable(),
  /** True when a saved address that nothing overrides differs from the one in use, so it applies from the host's next start. */
  restartNeeded: z.boolean(),
  /** The id the server knows this machine by. Null until a machine key exists. */
  machineId: z.string().nullable(),
  /** `machineFingerprint(machineId)`, which the owner compares with the one the client shows. Null exactly when `machineId` is. */
  machineFingerprint: z.string().nullable(),
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

/** The fingerprint the owner typed from their own browser, in any case, with or without dashes. */
export const approveDeviceBody = z.strictObject({ fingerprint: z.string().min(1).max(64) })
export type ApproveDeviceBody = z.infer<typeof approveDeviceBody>

/**
 * Why a tunneled request or socket was refused. `no_auth` is a socket whose
 * first message wasn't a valid auth message, or that sent none in time.
 */
export const auditRefusalReason = z.enum([
  'key_refused',
  'ticket_refused',
  'ticket_reused',
  'proof_refused',
  'device_not_approved',
  'no_auth',
  'unsealed',
])
export type AuditRefusalReason = z.infer<typeof auditRefusalReason>

/** A device fingerprint as the audit log keeps it. */
const auditFingerprint = z.string().min(1).max(64)
/** A local random id that ties a session's `closed` to its `opened`. */
const auditSession = z.string().min(1).max(64)
/** Who a tunneled socket opened as: the linked account's id, or an access key's id, never the key or its name. */
const auditAccount = z.strictObject({ principal: z.literal('account'), accountId: z.string().min(1).max(200) })
const auditKey = z.strictObject({ principal: z.literal('key'), keyId: z.string().min(1).max(64) })

/** A line of the audit log for a tunneled socket that opened. `at` is an ISO string, as in every line. */
export const auditOpenedLine = z.union([
  auditAccount.extend({
    kind: z.literal('opened'),
    session: auditSession,
    fingerprint: auditFingerprint,
    at: z.iso.datetime(),
  }),
  auditKey.extend({
    kind: z.literal('opened'),
    session: auditSession,
    fingerprint: auditFingerprint,
    at: z.iso.datetime(),
  }),
])

/** A line of the audit log for a tunneled socket that ended, for any reason. */
export const auditClosedLine = z.strictObject({
  kind: z.literal('closed'),
  session: auditSession,
  at: z.iso.datetime(),
})

/**
 * A line of the audit log for a refused tunneled request or socket.
 * `fingerprint` and `principal` are there only when a device proof verified.
 */
export const auditRefusedLine = z.strictObject({
  kind: z.literal('refused'),
  reason: auditRefusalReason,
  at: z.iso.datetime(),
  fingerprint: auditFingerprint.optional(),
  principal: z.enum(['account', 'key']).optional(),
})
export type AuditRefusedLine = z.infer<typeof auditRefusedLine>

/** One line of `remote-audit.jsonl`. */
export const auditLine = z.union([...auditOpenedLine.options, auditClosedLine, auditRefusedLine])
export type AuditLine = z.infer<typeof auditLine>

/** A tunneled socket's session: an `opened` line merged with its `closed`. `closedAt` is null when no close was recorded. */
export const auditSessionEntry = z.union([
  auditAccount.extend({
    kind: z.literal('session'),
    session: auditSession,
    fingerprint: auditFingerprint,
    openedAt: z.iso.datetime(),
    closedAt: z.iso.datetime().nullable(),
  }),
  auditKey.extend({
    kind: z.literal('session'),
    session: auditSession,
    fingerprint: auditFingerprint,
    openedAt: z.iso.datetime(),
    closedAt: z.iso.datetime().nullable(),
  }),
])
export type AuditSessionEntry = z.infer<typeof auditSessionEntry>

/** An entry of the audit log as the owner reads it: a session, or a refusal. */
export const auditLogEntry = z.union([...auditSessionEntry.options, auditRefusedLine])
export type AuditLogEntry = z.infer<typeof auditLogEntry>

/** The newest audit log entries, newest first. */
export const auditLogResponse = z.object({ entries: z.array(auditLogEntry) })
export type AuditLogResponse = z.infer<typeof auditLogResponse>
/** A credential a device's tunneled sockets came in with: the linked account, or an access key by its name. */
export const sessionCredential = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account') }),
  z.object({ kind: z.literal('key'), name: z.string() }),
])
export type SessionCredential = z.infer<typeof sessionCredential>

/**
 * An approved device with tunneled sockets open: each credential they came in
 * with once, how many are open, and when the first of them was authorized, an
 * ISO string.
 */
export const remoteSession = z.object({
  deviceId,
  fingerprint: z.string(),
  credentials: z.array(sessionCredential),
  sockets: z.number().int().positive(),
  startedAt: z.iso.datetime(),
})
export type RemoteSession = z.infer<typeof remoteSession>

/** The devices with tunneled sockets open, newest `startedAt` first. */
export const sessionsResponse = z.object({ sessions: z.array(remoteSession) })
export type SessionsResponse = z.infer<typeof sessionsResponse>

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
    description:
      'Approves the waiting browser with the typed fingerprint, compared without case, dashes or whitespace. One already approved answers the list unchanged. A fingerprint that matches no waiting browser gets a 404, and one that matches more than one gets a 409. Local callers only.',
    input: approveDeviceBody,
    output: devicesResponse,
  },
  removeDevice: {
    method: 'POST',
    path: '/api/remote-access/devices/remove',
    description: 'Dismisses a waiting browser, or revokes an approved one and closes its sockets. Local callers only.',
    input: deviceBody,
    output: devicesResponse,
  },
  auditLog: {
    method: 'GET',
    path: '/api/remote-access/audit-log',
    description:
      'Lists the newest remote access recorded on this machine, at most 50, newest first: the tunneled sockets that opened, as which device and account or key, and when they closed, and the refused requests and sockets. Local callers only.',
    input: z.object({}),
    output: auditLogResponse,
  },
  sessions: {
    method: 'GET',
    path: '/api/remote-access/sessions',
    description:
      'Lists the devices with tunneled sockets open, with the credentials they came in with. Local callers only.',
    input: z.object({}),
    output: sessionsResponse,
  },
  endSession: {
    method: 'POST',
    path: '/api/remote-access/sessions/end',
    description:
      "Closes a device's tunneled sockets with 4401, leaving it approved, and answers the list. An unknown id changes nothing. Local callers only.",
    input: deviceBody,
    output: sessionsResponse,
  },
})
