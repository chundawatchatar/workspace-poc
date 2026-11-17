import { existsSync } from 'node:fs'
import {
  buildRequest,
  type Endpoint,
  type EndpointInput,
  type EndpointOutput,
  formatLocalDateTime,
  type LinkedAccount,
  machineFingerprint,
  type RemoteAccessStatus,
  routes,
  sameServerUrl,
} from '@orch/shared'
import { devAddresses, type RemoteAccessEnv, type RemoteAddresses } from './modules/remote-access/addresses.service'
import { LinkedAccountRepository, linkedAccountPath } from './modules/remote-access/linked-account.repository'
import { DEFAULT_SERVER_URL } from './modules/remote-access/remote-access.service'
import { migrateRemoteAccessAddresses, readSettingsFile, settingsPath } from './modules/settings/settings.repository'
import { loadSettings, SETTINGS_DEFAULTS } from './modules/settings/settings.service'
import { loadOrCreateMachineKey, machineKeyFile } from './modules/tunnel/tunnel.repository'
import {
  type ConnectCommand,
  connectProblem,
  connectThroughHost,
  disconnectThroughHost,
  parseConnectArgs,
  parseDisconnectArgs,
} from './remote-cli-connect'
import {
  type DevicesCommand,
  devicesFromFile,
  devicesThroughHost,
  fileDevicesLine,
  hostDevicesLine,
  parseDevicesArgs,
} from './remote-cli-devices'
import { logFromFile, logThroughHost } from './remote-cli-log'
import { messageOf, printable, refused } from './remote-cli-output'
import { parseSessionsArgs, type SessionsCommand, sessionsFromFile, sessionsThroughHost } from './remote-cli-sessions'

// `bun run host:remote <command>`: the Remote access dialog for a terminal. A
// running host is the one owner of remote access, so every command goes
// through its local-only endpoints; only a host that refuses the connection is
// treated as stopped, and then the files in the data folder are read and
// written directly. Connect and Disconnect need the running host.

/** A running host's answer: the parsed output, or the status and message of a refusal. */
export type HostAnswer<E extends Endpoint> =
  | { ok: true; data: EndpointOutput<E> }
  | { ok: false; status: number; message: string }

/** Calls a host endpoint. Null means no host is running: the connection was refused. */
export type CallHost = <E extends Endpoint>(endpoint: E, input: EndpointInput<E>) => Promise<HostAnswer<E> | null>

export interface RemoteCliDeps {
  callHost: CallHost
  /** The host's data folder, holding its files directly. */
  dataDir: string
  /** The CLI's own environment. With the host stopped it only changes what `status` prints and adds hints. */
  env: RemoteAccessEnv
  /** Asks a question and answers the line typed. Null means the input ended. */
  prompt: (question: string) => Promise<string | null>
  out: (line: string) => void
  err: (line: string) => void
  /** The current time in milliseconds, for the ages `devices` prints and the time left `connect` prints. */
  now: () => number
  /**
   * Calls `handler` on Ctrl-C, instead of ending the process, until the
   * function it returns is called. `connect` uses it to cancel a request that
   * waits. Without it, Ctrl-C ends the process as usual.
   */
  onInterrupt?: (handler: () => void) => () => void
  /** How often `connect` reads the status while its request waits, in milliseconds. Defaults to a second. */
  pollMs?: number
  /** The command the usage names, `bun run host:remote` unless given. */
  program?: string
}

/** A caller for the host at `baseUrl`, such as `http://127.0.0.1:4599`. Answers are parsed with the output schemas. */
export function createHostCaller(baseUrl: string, fetchFn: typeof fetch = fetch): CallHost {
  return async (endpoint, input) => {
    const { url, body } = buildRequest(endpoint, input as Record<string, unknown>)
    let response: Response
    try {
      response = await fetchFn(`${baseUrl}${url}`, {
        method: endpoint.method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body,
      })
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'ConnectionRefused' || code === 'ECONNREFUSED') return null
      throw error
    }
    if (!response.ok) return { ok: false, status: response.status, message: await refusal(response) }
    // `parse` checks the shape at runtime; TS can't follow `E['output']` through the generic, so name the type.
    return { ok: true, data: endpoint.output.parse(await response.json()) as EndpointOutput<typeof endpoint> }
  }
}

/** The message of a refused request: the `error` of a JSON body, else the text. */
async function refusal(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') {
      return (body as { error: string }).error
    }
  } catch {}
  return text || `the host answered ${response.status}`
}

/** The usage text, naming `program`. */
const usage = (program: string) => `Usage: ${program} <command>

  status                                Show the server address, the connection, the machine id, the account
                                        and the devices
  connect --email <email> --key <key> [--server <url>] [--yes]
                                        Connect this machine to your account with a key from Connect a
                                        machine in the client, then wait until you accept it there;
                                        --server defaults to the built-in server (needs the running host)
  disconnect [--yes]                    Disconnect this machine from its account (needs the running host)
  devices                               List the devices waiting for approval and the approved ones
  devices approve <fingerprint> [--yes] Approve a waiting device by the fingerprint its browser shows (needs
                                        the running host)
  devices remove <fingerprint>          Dismiss a waiting device, or revoke an approved one
  sessions                              List the approved devices with tunneled sockets open
  log                                   Show the newest remote access: who opened this machine through the
                                        tunnel, and who was refused`

type Command = { name: 'status' | 'log' } | ConnectCommand | DevicesCommand | SessionsCommand

/** The command `args` names, or null when they don't make one. */
function parseArgs(args: string[]): Command | null {
  const [name, ...rest] = args
  if (name === 'status' || name === 'log') return rest.length === 0 ? { name } : null
  if (name === 'connect') return parseConnectArgs(rest)
  if (name === 'disconnect') return parseDisconnectArgs(rest)
  if (name === 'devices') return parseDevicesArgs(rest)
  if (name === 'sessions') return parseSessionsArgs(rest)
  return null
}

/** Runs one `host:remote` command and answers its exit code. Nothing it prints holds a credential or the machine's private key. */
export async function runRemote(args: string[], deps: RemoteCliDeps): Promise<number> {
  const command = parseArgs(args)
  if (!command) {
    deps.err(usage(deps.program ?? 'bun run host:remote'))
    return 1
  }
  // Refused before anything is sent, so a mistyped key, email or address never reaches the host.
  const problem = command.name === 'connect' ? connectProblem(command) : null
  if (problem) {
    deps.err(problem)
    return 1
  }
  const status = await deps.callHost(routes.remoteAccess.status, {})
  if (status === null) return stopped(command, deps)
  if (!status.ok) return refused(status, deps.err)
  return running(command, status.data, deps)
}

/** The commands against a running host, whose `status` is `current`. */
async function running(command: Command, current: RemoteAccessStatus, deps: RemoteCliDeps): Promise<number> {
  switch (command.name) {
    case 'status': {
      printStatus({ ...current, connected: Boolean(current.linkedAccount) }, deps.out)
      return (await hostDevicesLine(deps)) ? 0 : 1
    }
    case 'connect':
      return connectThroughHost(command, current, deps)
    case 'disconnect':
      return disconnectThroughHost(command, current, deps)
    case 'devices':
    case 'approve':
    case 'remove':
      return devicesThroughHost(command, deps)
    case 'sessions':
      return sessionsThroughHost(deps)
    case 'log':
      return logThroughHost(deps)
  }
}

/** The commands with the host stopped, reading and writing the data folder for its next start. */
function stopped(command: Command, deps: RemoteCliDeps): number {
  switch (command.name) {
    case 'status':
      return statusFromFiles(deps)
    case 'devices':
    case 'approve':
    case 'remove':
      return devicesFromFile(command, deps)
    case 'sessions':
      return sessionsFromFile(deps)
    case 'connect':
    case 'disconnect':
      deps.err('No host is running. Start it, then run this again')
      return 1
    case 'log':
      return logFromFile(deps)
  }
}

/**
 * Prints `status` from the files, as the host would show it at its next start
 * with this shell's `SERVER_URL` and `CLIENT_URL`, after migrating a folder
 * from before the settings file.
 */
function statusFromFiles(deps: RemoteCliDeps): number {
  const addresses = addressesFromFiles(deps)
  if (!addresses) return 1
  const { relayUrl, clientUrl } = addresses
  const account = readLinkedAccount(deps.dataDir, deps.err)
  const machineId = readMachineId(deps)
  printStatus(
    {
      serverUrl: relayUrl.value,
      serverUrlIsDefault: sameServerUrl(relayUrl.value, DEFAULT_SERVER_URL),
      serverUrlSetBy: relayUrl.setBy,
      clientUrl: clientUrl.source === 'derived' ? null : clientUrl.value,
      clientUrlSetBy: clientUrl.setBy,
      connected: account === undefined ? null : account !== null,
      tunnel: 'host not running',
      machineId,
      machineFingerprint: machineId === null ? null : machineFingerprint(machineId),
      linkedAccount: account,
    },
    deps.out,
  )
  const devicesRead = fileDevicesLine(deps)
  return account === undefined || !devicesRead ? 1 : 0
}

/**
 * The account `linked-account.json` in `dataDir` holds: null when there is
 * none, undefined after printing why the file can't be read.
 */
export function readLinkedAccount(dataDir: string, err: (line: string) => void): LinkedAccount | null | undefined {
  try {
    return new LinkedAccountRepository(linkedAccountPath(dataDir)).load()
  } catch (error) {
    err(messageOf(error))
    return undefined
  }
}

/** What `status` prints, from a running host or from the files. */
interface StatusView {
  serverUrl: string
  serverUrlIsDefault: boolean
  /** The flag or environment variable that sets the server address. Null means none does. */
  serverUrlSetBy: string | null
  /** The client address in use. Null means it is derived from the server address. */
  clientUrl: string | null
  clientUrlSetBy: string | null
  /** True when the machine is connected to an account. Null when the linked account file could not be read. */
  connected: boolean | null
  tunnel: string
  machineId: string | null
  /** The fingerprint of `machineId`, which the client shows for the owner to compare. Null exactly when it is. */
  machineFingerprint: string | null
  /** Undefined when the linked account file could not be read. */
  linkedAccount: LinkedAccount | null | undefined
}

function printStatus(view: StatusView, out: (line: string) => void) {
  const from = (setBy: string | null) => setBy !== null && `(from ${printable(setBy)})`
  const marks = [view.serverUrlIsDefault && '(default)', from(view.serverUrlSetBy)].filter(Boolean)
  out(`Server address: ${[printable(view.serverUrl), ...marks].join(' ')}`)
  const client = view.clientUrl === null ? 'derived from the server address' : printable(view.clientUrl)
  out(`Client address: ${[client, from(view.clientUrlSetBy)].filter(Boolean).join(' ')}`)
  const connection = view.connected === null ? 'unknown' : view.connected ? 'connected' : 'not connected'
  out(`Connection:     ${connection}, tunnel ${view.tunnel}`)
  out(`Machine id:     ${view.machineId === null ? 'none yet' : printable(view.machineId)}`)
  out(`Machine key:    ${view.machineFingerprint === null ? 'none yet' : printable(view.machineFingerprint)}`)
  out(`Account:        ${view.linkedAccount === undefined ? 'not readable' : accountLine(view.linkedAccount)}`)
}

/** Whether the machine is connected, and to which account and server, as `corch status` says it. */
export function connectionSummary(account: LinkedAccount | null): string {
  if (!account) return 'not connected'
  return `connected to ${printable(account.name)} (${printable(account.maskedEmail)}) through ${printable(account.serverUrl)}`
}

/** The account a machine is connected to, with its server, or `not connected`. Values are made safe for a terminal. */
export function accountLine(account: LinkedAccount | null): string {
  if (!account) return 'not connected'
  const { name, maskedEmail, serverUrl } = account
  return `${printable(name)} (${printable(maskedEmail)}) through ${printable(serverUrl)}, connected ${formatLocalDateTime(account.linkedAt)}`
}

/** Migrates a folder from before the settings file. False after printing why it could not. */
function migrate(deps: RemoteCliDeps): boolean {
  try {
    migrateRemoteAccessAddresses(deps.dataDir)
    return true
  } catch (error) {
    deps.err(messageOf(error))
    return false
  }
}

/**
 * The addresses a host started now would use, from the settings file and this
 * shell's `SERVER_URL` and `CLIENT_URL`, after migrating. Null after printing
 * why the files could not be read.
 */
function addressesFromFiles(deps: RemoteCliDeps): RemoteAddresses | null {
  if (!migrate(deps)) return null
  try {
    const file = readSettingsFile(settingsPath(deps.dataDir))
    const settings = loadSettings({ flags: {}, env: {}, file, defaults: SETTINGS_DEFAULTS })
    return devAddresses(settings, deps.env, deps.err)
  } catch (error) {
    deps.err(messageOf(error))
    return null
  }
}

/** The machine id from an existing machine key. Never creates one, so `status` leaves the data folder as it was. */
function readMachineId(deps: RemoteCliDeps): string | null {
  const file = machineKeyFile(deps.dataDir)
  if (!existsSync(file)) return null
  try {
    return loadOrCreateMachineKey(file).machineId
  } catch (error) {
    // The repository's message never contains the key.
    deps.err(messageOf(error))
    return null
  }
}
