import { accessContract } from './access'
import { eventsSocket } from './events'
import { fsContract } from './fs'
import { gitContract } from './git'
import { remoteAccessContract } from './remoteAccess'
import { serverAccountContract } from './serverAccount'
import { serverMachinesContract } from './serverMachines'
import { serverSystemContract } from './serverSystem'
import { systemContract } from './system'
import { terminalSocket } from './terminals'

export { type RotateAccessResponse, rotateAccessResponse } from './access'
export * from './contract'
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
  ACCESS_KEY_HEADER,
  CLOSE_ACCESS_DENIED,
  CLOSE_MACHINE_OFFLINE,
  CLOSE_RATE_LIMITED,
  type ConnectTarget,
  formatConnectFragment,
  MACHINE_API_ROUTE,
  MACHINE_WS_ROUTE,
  machinePathPrefix,
  parseConnectFragment,
  type SocketAuthMessage,
  socketAuthMessage,
} from './remote'
export {
  type RemoteAccessStatus,
  remoteAccessStatus,
  type TunnelState,
  tunnelState,
  type UpdateRemoteAccessBody,
  updateRemoteAccessBody,
} from './remoteAccess'
export * from './server'
export { type ServerMe, serverMeResponse } from './serverAccount'
export {
  type LinkMachineBody,
  type ListMachinesResponse,
  linkMachineBody,
  listMachinesResponse,
  machineIdSchema,
  machineNameSchema,
  type RenameMachineBody,
  renameMachineBody,
  type ServerMachine,
  serverMachine,
  unlinkMachineBody,
  unlinkMachineResponse,
} from './serverMachines'
export { serverHealthResponse } from './serverSystem'
export { type DaemonReport, daemonResponse, healthResponse } from './system'
export {
  authFailedFrame,
  CLOSE_HEARTBEAT_TIMEOUT,
  CLOSE_REPLACED,
  CLOSE_UNSUPPORTED_VERSION,
  decodeFrame,
  encodeFrame,
  helloFrame,
  httpBodyFrame,
  httpEndFrame,
  httpRequestFrame,
  httpResponseFrame,
  MAX_TUNNEL_FRAME_BYTES,
  type MachineFrame,
  machineFrame,
  pingFrame,
  pongFrame,
  type ServerFrame,
  serverFrame,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
  type TunnelFrame,
  WS_CHANNEL_WINDOW_BYTES,
  welcomeFrame,
  wsAckFrame,
  wsCloseFrame,
  wsDataFrame,
  wsOpenFrame,
  wsPayloadBytes,
} from './tunnel'

/**
 * Every route the host serves. Use these on both sides instead of writing paths:
 * `createRouter(routes.git, …)` on the host, `callApi(routes.git.status, { cwd })` in `@orch/terminal-ui`.
 */
export const routes = {
  system: systemContract,
  fs: fsContract,
  git: gitContract,
  access: accessContract,
  remoteAccess: remoteAccessContract,
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
