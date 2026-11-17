import { z } from 'zod'
import { defineContract } from './contract'
import { accountEmailSchema, enrollmentKeySchema } from './serverMachines'

/**
 * Where the tunnel to the server stands: `connecting` while it dials or waits
 * for `welcome`, `reconnecting` while it waits to dial again, `stopped` once
 * the server refused it for good, and `off` while the machine is not connected
 * to an account.
 */
export const tunnelState = z.enum(['off', 'connecting', 'connected', 'reconnecting', 'stopped'])
export type TunnelState = z.infer<typeof tunnelState>

/** An account as the server shows it to a machine: its name, and only the first character of the email's local part. */
export const linkAccount = z.object({ name: z.string(), maskedEmail: z.string() })
export type LinkAccount = z.infer<typeof linkAccount>

/** The account this machine is linked to. `serverUrl` is the server it was linked through, `linkedAt` an ISO string. */
export const linkedAccount = linkAccount.extend({ serverUrl: z.string(), linkedAt: z.iso.datetime() })
export type LinkedAccount = z.infer<typeof linkedAccount>

/**
 * A Connect the server holds until the owner accepts or rejects it in the
 * client. `expiresAt` is an ISO string on the host's clock: the host gives up
 * then, when the key expires.
 */
export const connectRequestStatus = z.object({ expiresAt: z.iso.datetime() })
export type ConnectRequestStatus = z.infer<typeof connectRequestStatus>

/**
 * What the host says while its connect request waits, in the Remote access
 * dialog and in `corch connect`: the owner accepts it in the client after
 * checking the client shows the same machine fingerprint.
 */
export function connectApprovalText(machineFingerprint: string): string {
  return `Please approve this connect request in the client and check that it shows machine ${machineFingerprint}`
}

/**
 * How a Connect that waited ended without linking the machine: the owner
 * `rejected` it, its key `expired`, the owner `cancelled` it on the machine,
 * or it `failed`, as when the tunnel dropped.
 */
export const connectOutcomeKind = z.enum(['rejected', 'expired', 'cancelled', 'failed'])
export type ConnectOutcomeKind = z.infer<typeof connectOutcomeKind>

/** How the last Connect ended unlinked, with a message for the owner that never holds the key or the email. */
export const connectOutcome = z.object({ kind: connectOutcomeKind, message: z.string() })
export type ConnectOutcome = z.infer<typeof connectOutcome>

export const remoteAccessStatus = z.object({
  /**
   * The server address in use: a flag or the environment, else the one saved in
   * the host's settings file, else the default. Connect saves the one it uses.
   */
  serverUrl: z.string(),
  /** True when the server address in use is the built-in default. */
  serverUrlIsDefault: z.boolean(),
  /** The built-in default server address. */
  defaultServerUrl: z.string(),
  /** The client address for connect links in use. Null means it is derived from `serverUrl`. */
  clientUrl: z.string().nullable(),
  /** The flag or environment variable that sets the server address, such as `SERVER_URL`. Null means none does. */
  serverUrlSetBy: z.string().nullable(),
  /** The flag or environment variable that sets the client address, such as `CLIENT_URL`. Null means none does. */
  clientUrlSetBy: z.string().nullable(),
  /** The id the server knows this machine by. Null until a machine key exists. */
  machineId: z.string().nullable(),
  /** `machineFingerprint(machineId)`, which the owner compares with the one the client shows. Null exactly when `machineId` is. */
  machineFingerprint: z.string().nullable(),
  tunnel: tunnelState,
  /** The account this machine is connected to. Null means it is not connected. */
  linkedAccount: linkedAccount.nullable(),
  /** The Connect waiting for the owner's answer in the client. Null means none waits. */
  connectRequest: connectRequestStatus.nullable(),
  /** How the last Connect that waited ended without linking. Null after a link, and from the next Connect on. */
  connectOutcome: connectOutcome.nullable(),
})
export type RemoteAccessStatus = z.infer<typeof remoteAccessStatus>

/**
 * What Connect takes: the account's email and an enrollment key from the
 * client, and the server address, `wss://<host>` or `ws://` on a loopback host.
 * No message about them ever quotes them.
 */
export const connectBody = z.strictObject({
  email: accountEmailSchema,
  key: enrollmentKeySchema,
  serverUrl: z.string().max(2048),
})
export type ConnectBody = z.infer<typeof connectBody>

/**
 * What Disconnect answers: the status, now not connected, and whether the
 * server removed this machine from the account's list. False means the owner
 * removes it in the client.
 */
export const disconnectResponse = z.object({ status: remoteAccessStatus, removedFromAccount: z.boolean() })
export type DisconnectResponse = z.infer<typeof disconnectResponse>

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
    description:
      'Reports the server address, the account this machine is connected to and the state of the tunnel. Local callers only.',
    input: z.object({}),
    output: remoteAccessStatus,
  },
  connect: {
    method: 'POST',
    path: '/api/remote-access/connect',
    description:
      "Starts connecting this machine to the account whose key and email it gets: saves the server address, opens the tunnel to it and sends the key over it, then answers once the server holds the request for the owner, with `connectRequest` set. The owner's answer in the client, an expiry or a cancel shows in the status later. A connected machine, one already connecting, or an address other than the one a flag or variable sets gets a 409; an address the host refuses gets a 400. On any failure nothing is linked and the tunnel is stopped. Local callers only.",
    input: connectBody,
    output: remoteAccessStatus,
  },
  cancelConnect: {
    method: 'POST',
    path: '/api/remote-access/connect/cancel',
    description:
      'Ends a Connect on its way or waiting for the owner, before the machine is linked: stops the tunnel, so the server drops the request, and sets `connectOutcome` to `cancelled`. With none on its way it changes nothing. Local callers only.',
    input: z.strictObject({}),
    output: remoteAccessStatus,
  },
  disconnect: {
    method: 'POST',
    path: '/api/remote-access/disconnect',
    description:
      "Asks the server over the tunnel to remove this machine from the account's list, when it can, then forgets the account and its browsers on this machine and stops the tunnel. A machine that is not connected changes nothing. Local callers only.",
    input: z.strictObject({}),
    output: disconnectResponse,
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
