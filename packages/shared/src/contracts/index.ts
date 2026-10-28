import { accessContract } from './access'
import { eventsSocket } from './events'
import { fsContract } from './fs'
import { gitContract } from './git'
import { remoteAccessContract } from './remoteAccess'
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
