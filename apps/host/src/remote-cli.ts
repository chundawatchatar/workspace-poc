import { existsSync } from 'node:fs'
import {
  buildRequest,
  type Endpoint,
  type EndpointInput,
  type EndpointOutput,
  enrollmentKeySchema,
  formatLocalDateTime,
  type LinkedAccount,
  machineFingerprint,
  type PreviewLinkResponse,
  type RemoteAccessStatus,
  routes,
} from '@orch/shared'
import {
  devAddresses,
  enteredServerUrl,
  type RemoteAccessEnv,
  type RemoteAddresses,
} from './modules/remote-access/addresses.service'
import { LinkedAccountRepository, linkedAccountPath } from './modules/remote-access/linked-account.repository'
import {
  RemoteAccessRepository,
  remoteAccessPath,
  type StoredRemoteAccess,
} from './modules/remote-access/remote-access.repository'
import { DEFAULT_SERVER_URL } from './modules/remote-access/remote-access.service'
import {
  migrateRemoteAccessAddresses,
  readSettingsFile,
  saveAddresses,
  settingsPath,
} from './modules/settings/settings.repository'
import { loadSettings, SETTINGS_DEFAULTS } from './modules/settings/settings.service'
import { loadOrCreateMachineKey, machineKeyFile } from './modules/tunnel/tunnel.repository'
import { parseServerUrl } from './modules/tunnel/tunnel.service'
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
// running host is the one owner of the setting, so every command goes through
// its local-only endpoints; only a host that refuses the connection is treated
// as stopped, and then the files in the data folder are read and written directly.
// Either way an address changes from the host's next start.

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
  /** The current time in milliseconds, for the ages `devices` prints. */
  now: () => number
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

  status                                Show the server address, remote access, the machine id, the linked
                                        account and the devices
  server <url>                          Set the server address: wss://<host>, or ws:// on 127.0.0.1, [::1]
                                        or localhost
  on                                    Turn remote access on
  off                                   Turn remote access off
  link <key> [--yes]                    Link this machine to an account with an enrollment key (needs the
                                        running host)
  unlink                                Forget the linked account on this machine
  devices                               List the devices waiting for approval and the approved ones
  devices approve <fingerprint> [--yes] Approve a waiting device by the fingerprint its browser shows (needs
                                        the running host)
  devices remove <fingerprint>          Dismiss a waiting device, or revoke an approved one
  sessions                              List the approved devices with tunneled sockets open
  log                                   Show the newest remote access: who opened this machine through the
                                        tunnel, and who was refused`

const FORGOTTEN =
  'The account is forgotten on this machine only. The server still lists the machine until you unlink it in the client.'

type Command =
  | { name: 'status' | 'unlink' | 'log' }
  | { name: 'on' | 'off' }
  | { name: 'server'; url: string }
  | { name: 'link'; key: string; yes: boolean }
  | DevicesCommand
  | SessionsCommand

/** A command that changes the saved setting. */
type SettingCommand = Extract<Command, { name: 'server' | 'on' | 'off' }>

/** The command `args` names, or null when they don't make one. */
function parseArgs(args: string[]): Command | null {
  const [name, ...rest] = args
  if (name === 'status' || name === 'unlink' || name === 'log') return rest.length === 0 ? { name } : null
  if (name === 'on' || name === 'off') return rest.length === 0 ? { name } : null
  if (name === 'server') return rest.length === 1 && rest[0] ? { name, url: rest[0] } : null
  if (name === 'link') {
    const yes = rest.includes('--yes')
    const keys = rest.filter((arg) => arg !== '--yes')
    return keys.length === 1 && keys[0] ? { name, key: keys[0], yes } : null
  }
  if (name === 'devices') return parseDevicesArgs(rest)
  if (name === 'sessions') return parseSessionsArgs(rest)
  return null
}

/** Runs one `host:remote` command and answers its exit code. Nothing it prints holds an access key or the machine's private key. */
export async function runRemote(args: string[], deps: RemoteCliDeps): Promise<number> {
  const command = parseArgs(args)
  if (!command) {
    deps.err(usage(deps.program ?? 'bun run host:remote'))
    return 1
  }
  // Refused before anything is sent, so a mistyped key or address never reaches the host.
  if (command.name === 'link' && !enrollmentKeySchema.safeParse(command.key).success) {
    deps.err('That is not an enrollment key. Copy it again from Connect a machine in the client')
    return 1
  }
  if (command.name === 'server') {
    try {
      enteredServerUrl(command.url)
    } catch (error) {
      deps.err(messageOf(error))
      return 1
    }
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
      printStatus(current, deps.out)
      return (await hostDevicesLine(deps)) ? 0 : 1
    }
    case 'server':
    case 'on':
    case 'off':
      return updateThroughHost(command, current, deps)
    case 'devices':
    case 'approve':
    case 'remove':
      return devicesThroughHost(command, deps)
    case 'sessions':
      return sessionsThroughHost(deps)
    case 'link':
      return linkThroughHost(command, deps)
    case 'log':
      return logThroughHost(deps)
    case 'unlink': {
      if (!current.linkedAccount) {
        deps.out('No account is linked')
        return 0
      }
      const answer = await deps.callHost(routes.remoteAccess.unlink, {})
      if (!answer?.ok) return refused(answer, deps.err)
      deps.out(FORGOTTEN)
      return 0
    }
  }
}

/** Sends one `update` that changes only what `command` names, keeping the rest of what is saved. */
async function updateThroughHost(command: SettingCommand, current: RemoteAccessStatus, deps: RemoteCliDeps) {
  if (command.name === 'server' && current.serverUrlSetBy) {
    deps.err(`${printable(current.serverUrlSetBy)} sets the server address; change it there`)
    return 1
  }
  // The host would overwrite a setting file it could not read, so the CLI refuses first.
  if (readSettings(deps) === false) return 1
  const answer = await deps.callHost(routes.remoteAccess.update, {
    enabled: command.name === 'server' ? current.enabled : command.name === 'on',
    serverUrl: command.name === 'server' ? command.url : (current.savedServerUrl ?? ''),
    clientUrl: current.savedClientUrl,
  })
  if (!answer?.ok) return refused(answer, deps.err)
  if (command.name === 'server') deps.out(serverSavedLine(answer.data.savedServerUrl))
  deps.out(remoteAccessLine(answer.data.enabled, answer.data.tunnel))
  if (command.name === 'on') deps.out('A newly created connect link is printed in the host log, not here.')
  return 0
}

/** Previews the key, asks unless `--yes` was given, then links with the previewed server address. */
async function linkThroughHost(command: Extract<Command, { name: 'link' }>, deps: RemoteCliDeps) {
  const preview = await deps.callHost(routes.remoteAccess.previewLink, { key: command.key })
  if (!preview?.ok) return refused(preview, deps.err)
  printPreview(preview.data, deps.out)
  if (!command.yes) {
    const answer = await deps.prompt(`Link this machine to ${printable(preview.data.account.name)}? [y/N] `)
    if (!/^(y|yes)$/i.test(answer?.trim() ?? '')) {
      deps.err('Not linked')
      return 1
    }
  }
  deps.out('Linking...')
  const linked = await deps.callHost(routes.remoteAccess.link, { key: command.key, serverUrl: preview.data.serverUrl })
  if (!linked?.ok) return refused(linked, deps.err)
  deps.out(`Linked: ${accountLine(linked.data.linkedAccount)}`)
  return 0
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
    case 'server':
    case 'on':
    case 'off':
      return saveSetting(command, deps)
    case 'link':
      deps.err('Start the host and turn remote access on, then run this again')
      return 1
    case 'log':
      return logFromFile(deps)
    case 'unlink': {
      const file = linkedAccountPath(deps.dataDir)
      if (!existsSync(file)) {
        deps.out('No account is linked')
        return 0
      }
      // Removed even when it is not valid, so a broken file can always be cleared.
      new LinkedAccountRepository(file).remove()
      deps.out(FORGOTTEN)
      return 0
    }
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
  const settings = readSettings(deps)
  let account: LinkedAccount | null | undefined
  try {
    account = new LinkedAccountRepository(linkedAccountPath(deps.dataDir)).load()
  } catch (error) {
    deps.err(messageOf(error))
  }
  const saved = settings || null
  const machineId = readMachineId(deps)
  printStatus(
    {
      serverUrl: relayUrl.value,
      serverUrlIsDefault: isDefaultServer(relayUrl.value),
      serverUrlSetBy: relayUrl.setBy,
      clientUrl: clientUrl.source === 'derived' ? null : clientUrl.value,
      clientUrlSetBy: clientUrl.setBy,
      restartNeeded: false,
      enabled: settings === false ? null : relayUrl.setBy === 'SERVER_URL' || Boolean(saved?.enabled),
      tunnel: 'host not running',
      machineId,
      machineFingerprint: machineId === null ? null : machineFingerprint(machineId),
      linkedAccount: account,
    },
    deps.out,
  )
  const devicesRead = fileDevicesLine(deps)
  return settings === false || account === undefined || !devicesRead ? 1 : 0
}

/**
 * Saves what `command` names for the host's next start: the server address in
 * the settings file, keeping its other keys, or the flag in `remote-access.json`.
 * A missing `remote-access.json` counts as off. Folders from before the
 * settings file are migrated first.
 */
function saveSetting(command: SettingCommand, deps: RemoteCliDeps): number {
  if (!migrate(deps)) return 1
  if (command.name === 'server') {
    const relayUrl = enteredServerUrl(command.url)
    try {
      saveAddresses(settingsPath(deps.dataDir), { relayUrl })
    } catch (error) {
      deps.err(messageOf(error))
      return 1
    }
    deps.out(serverSavedLine(relayUrl))
  } else {
    if (readSettings(deps) === false) return 1
    new RemoteAccessRepository(remoteAccessPath(deps.dataDir)).save({ enabled: command.name === 'on' })
    deps.out(`Remote access turned ${command.name}. The change applies when the host next starts.`)
  }
  if (deps.env.SERVER_URL && command.name !== 'on') {
    deps.out('SERVER_URL is set in this shell: a host started with it uses that address and turns remote access on.')
  }
  return 0
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
  /** True when a saved address applies only from the host's next start. */
  restartNeeded: boolean
  /** Null when the setting file could not be read. */
  enabled: boolean | null
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
  if (view.restartNeeded) out('Saved address:  changed. The host uses the saved addresses from its next start.')
  out(view.enabled === null ? 'Remote access:  setting not readable' : remoteAccessLine(view.enabled, view.tunnel))
  out(`Machine id:     ${view.machineId === null ? 'none yet' : printable(view.machineId)}`)
  out(`Machine key:    ${view.machineFingerprint === null ? 'none yet' : printable(view.machineFingerprint)}`)
  out(`Account:        ${view.linkedAccount === undefined ? 'not readable' : accountLine(view.linkedAccount)}`)
}

export function remoteAccessLine(enabled: boolean, tunnel: string): string {
  return `Remote access:  ${enabled ? 'on' : 'off'}, tunnel ${tunnel}`
}

function accountLine(account: LinkedAccount | null): string {
  if (!account) return 'not linked'
  const { name, maskedEmail, serverUrl } = account
  return `${printable(name)} (${printable(maskedEmail)}) through ${printable(serverUrl)}, linked ${formatLocalDateTime(account.linkedAt)}`
}

/** Prints the three things to check before a key is used. */
function printPreview(preview: PreviewLinkResponse, out: (line: string) => void) {
  out(`Server:      ${printable(preview.serverUrl)}`)
  if (!preview.serverUrlIsDefault) {
    out('Warning:     this is not the default server. Link only if you run it or trust who does.')
  }
  out(`Account:     ${printable(preview.account.name)} (${printable(preview.account.maskedEmail)})`)
  out(`Fingerprint: ${printable(preview.fingerprint)} (the same 4 characters must show in the client)`)
}

/** What `server` prints once the address is saved. Null means none is saved, so the default is used. */
function serverSavedLine(saved: string | null): string {
  const address = saved === null ? 'the default' : printable(saved)
  return `Server address saved: ${address}. The host uses it from its next start.`
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

/** The saved setting, null when none is saved, or false after printing why the file is not valid. */
function readSettings(deps: RemoteCliDeps): StoredRemoteAccess | null | false {
  try {
    return new RemoteAccessRepository(remoteAccessPath(deps.dataDir)).load()
  } catch (error) {
    deps.err(messageOf(error))
    return false
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

function isDefaultServer(serverUrl: string): boolean {
  const inUse = parseServerUrl(serverUrl)
  return inUse !== null && inUse === parseServerUrl(DEFAULT_SERVER_URL)
}
