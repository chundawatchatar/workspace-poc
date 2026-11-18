import { agentTrackingContract } from './agentTracking'
import { e2eContract } from './e2eSession'
import { eventsSocket } from './events'
import { fsContract } from './fs'
import { gitContract } from './git'
import { remoteAccessContract } from './remoteAccess'
import { serverAccountContract } from './serverAccount'
import { serverMachinesContract } from './serverMachines'
import { serverSystemContract } from './serverSystem'
import { systemContract } from './system'
import { terminalSocket } from './terminals'

export {
  type AgentTrackingAnswer,
  type AgentTrackingStatus,
  agentTrackingAnswer,
  agentTrackingStatus,
  type TrackedAgent,
  trackedAgent,
  type UpdateAgentTrackingBody,
  updateAgentTrackingBody,
} from './agentTracking'
export * from './contract'
export {
  CLOSE_DEVICE_NOT_APPROVED,
  canonicalDeviceJwk,
  DEVICE_NOT_APPROVED_CODE,
  DEVICE_PROOF_HEADER,
  DEVICE_PROOF_SKEW_SECONDS,
  DEVICE_PROOF_SOCKET_METHOD,
  type DeviceJwk,
  type DeviceProofHeader,
  type DeviceProofPayload,
  deviceFingerprint,
  deviceJwk,
  deviceProofHeader,
  deviceProofPayload,
  fingerprintKey,
} from './deviceProof'
export {
  answerBrowserHandshake,
  type BrowserHandshake,
  E2E_VERSION,
  type E2eBrowserHello,
  type E2eChannel,
  type E2eDeviceSigner,
  E2eError,
  type E2eErrorReason,
  type E2eJwk,
  type E2eMachineHello,
  type E2eMachineSigner,
  type E2eSession,
  e2eBrowserHello,
  e2eMachineHello,
  MAX_E2E_CHANNEL,
  type MachineHandshake,
  startBrowserHandshake,
} from './e2e'
export {
  decodeEnvelope,
  decodeRequestRecord,
  decodeResponseRecord,
  E2E_REQUIRED_CODE,
  E2E_SESSION_UNKNOWN_CODE,
  type E2eEnvelope,
  type E2eHttpHead,
  type E2eHttpRequest,
  type E2eHttpResponseRecord,
  e2eHttpHead,
  e2eHttpRequest,
  encodeEnvelope,
  encodeRequestRecord,
  encodeResponseRecord,
  frameRecord,
  MAX_E2E_ENVELOPE_BYTES,
  MAX_E2E_RECORD_BYTES,
  RecordFramer,
} from './e2eHttp'
export {
  e2eContract,
  e2eSessionId,
  type OpenE2eSessionResponse,
  openE2eSessionResponse,
} from './e2eSession'
export {
  decodeSocketMessageRecord,
  decodeSocketOpenRecord,
  type E2eSocketMessage,
  type E2eSocketOpen,
  e2eSocketOpen,
  encodeSocketMessageRecord,
  encodeSocketOpenRecord,
  MAX_E2E_SOCKET_MESSAGE_BYTES,
} from './e2eSocket'
export {
  type DirListing,
  listDirsQuery,
  listDirsResponse,
  makeDirBody,
  makeDirResponse,
  resolveDirQuery,
  resolveDirResponse,
} from './fs'
export { type GitInfo, gitStatusQuery, gitStatusResponse } from './git'
export {
  type MachineKeyResponse,
  machineFingerprint,
  machineKeyMatches,
  machineKeyResponse,
  machinePublicKey,
} from './machineKey'
export {
  RELAY_SOCKET_PROTOCOL,
  RELAY_TICKET_HEADER,
  RELAY_TICKET_PROTOCOL_PREFIX,
  RELAY_TICKET_TTL_SECONDS,
  type RelayKey,
  type RelayTicketHeader,
  type RelayTicketPayload,
  type RelayTicketResponse,
  relayKey,
  relayKeyId,
  relayKeyList,
  relaySocketProtocols,
  relayTicketHeader,
  relayTicketPayload,
  relayTicketResponse,
  ticketFromProtocols,
} from './relayTicket'
export {
  CLOSE_ACCESS_DENIED,
  CLOSE_E2E_SESSION_UNKNOWN,
  CLOSE_MACHINE_OFFLINE,
  CLOSE_RATE_LIMITED,
  CLOSE_SESSION_ENDED,
  MACHINE_API_ROUTE,
  MACHINE_SEALED_ROUTE,
  MACHINE_SEALED_SOCKET_ROUTE,
  MACHINE_WS_ROUTE,
  machinePathPrefix,
  machineSealedPath,
  machineSealedSocketPath,
  type SocketAuthMessage,
  socketAuthMessage,
} from './remote'
export {
  type ApproveDeviceBody,
  type ApprovedDevice,
  type AuditLine,
  type AuditLogEntry,
  type AuditLogResponse,
  type AuditRefusalReason,
  type AuditRefusedLine,
  type AuditSessionEntry,
  approveDeviceBody,
  approvedDevice,
  auditClosedLine,
  auditLine,
  auditLogEntry,
  auditLogResponse,
  auditOpenedLine,
  auditRefusalReason,
  auditRefusedLine,
  auditSessionEntry,
  type ConnectBody,
  type ConnectOutcome,
  type ConnectOutcomeKind,
  type ConnectRequestStatus,
  connectApprovalText,
  connectBody,
  connectOutcome,
  connectOutcomeKind,
  connectRequestStatus,
  type DeviceBody,
  type DevicesResponse,
  type DisconnectResponse,
  deviceBody,
  deviceId,
  devicesResponse,
  disconnectResponse,
  type LinkAccount,
  type LinkedAccount,
  linkAccount,
  linkedAccount,
  type PendingDevice,
  pendingDevice,
  type RemoteAccessStatus,
  type RemoteSession,
  remoteAccessStatus,
  remoteSession,
  type SessionCredential,
  type SessionsResponse,
  sessionCredential,
  sessionsResponse,
  type TunnelState,
  tunnelState,
} from './remoteAccess'
export * from './server'
export { type ServerMe, serverMeResponse } from './serverAccount'
export {
  accountEmailSchema,
  type ConnectRequest,
  type CreateEnrollmentResponse,
  connectRequest,
  connectRequestBody,
  connectRequestIdSchema,
  createEnrollmentResponse,
  enrollmentFingerprint,
  enrollmentKeySchema,
  type ListMachinesResponse,
  type ListRequestsResponse,
  listMachinesResponse,
  listRequestsResponse,
  machineIdSchema,
  machineNameSchema,
  type RenameMachineBody,
  rejectRequestResponse,
  renameMachineBody,
  type ServerMachine,
  serverMachine,
  unlinkMachineBody,
  unlinkMachineResponse,
} from './serverMachines'
export { serverHealthResponse } from './serverSystem'
export { type DaemonCompatibility, type DaemonReport, daemonResponse, healthResponse, instanceResponse } from './system'
export {
  authFailedFrame,
  CLOSE_HEARTBEAT_TIMEOUT,
  CLOSE_REPLACED,
  CLOSE_UNSUPPORTED_VERSION,
  challengeFrame,
  decodeFrame,
  encodeFrame,
  enrollFailedFrame,
  enrollRedeemedFrame,
  enrollRequestFrame,
  enrollWaitingFrame,
  helloFrame,
  helloSignedMessage,
  httpBodyFrame,
  httpEndFrame,
  httpRequestFrame,
  httpResponseFrame,
  httpSealedFrame,
  MAX_TUNNEL_FRAME_BYTES,
  type MachineFrame,
  machineFrame,
  machineIdFromPublicKey,
  parseServerUrl,
  pingFrame,
  pongFrame,
  type ServerFrame,
  sameServerUrl,
  serverFrame,
  sessionEndedFrame,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
  type TunnelFrame,
  unlinkedFrame,
  unlinkFailedFrame,
  unlinkFrame,
  WS_CHANNEL_WINDOW_BYTES,
  welcomeFrame,
  wsAckFrame,
  wsCloseFrame,
  wsDataFrame,
  wsOpenFrame,
  wsPayloadBytes,
  wsSealedFrame,
} from './tunnel'

/**
 * Every route the host serves. Use these on both sides instead of writing paths:
 * `createRouter(routes.git, …)` on the host, `callApi(routes.git.status, { cwd })` in `@orch/terminal-ui`.
 */
export const routes = {
  system: systemContract,
  fs: fsContract,
  git: gitContract,
  remoteAccess: remoteAccessContract,
  agentTracking: agentTrackingContract,
  e2e: e2eContract,
  sockets: {
    events: eventsSocket,
    terminal: terminalSocket,
  },
}

/**
 * Every endpoint of the cloud server's own API, apart from `routes`, which the
 * server relays to machines under `/m/<id>`. `createServerRouter(serverRoutes.system, …)`
 * in `apps/server`, `callServer(serverRoutes.system.health, {})` in `apps/client`.
 */
export const serverRoutes = {
  system: serverSystemContract,
  account: serverAccountContract,
  machines: serverMachinesContract,
}
