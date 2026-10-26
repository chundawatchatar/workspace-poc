import { eventsSocket } from './events'
import { fsContract } from './fs'
import { gitContract } from './git'
import { systemContract } from './system'
import { terminalSocket } from './terminals'

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
export { type DaemonReport, daemonResponse, healthResponse } from './system'
export {
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
  type RelayFrame,
  relayFrame,
  TUNNEL_PROTOCOL_VERSION,
  type TunnelFrame,
  welcomeFrame,
  wsCloseFrame,
  wsDataFrame,
  wsOpenFrame,
} from './tunnel'

/**
 * Every route the host serves. Use these on both sides instead of writing paths:
 * `createRouter(routes.git, …)` on the host, `callApi(routes.git.status, { cwd })` in the web app.
 */
export const routes = {
  system: systemContract,
  fs: fsContract,
  git: gitContract,
  sockets: {
    events: eventsSocket,
    terminal: terminalSocket,
  },
}
