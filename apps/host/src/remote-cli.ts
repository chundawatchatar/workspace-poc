import { existsSync } from 'node:fs'
import {
  buildRequest,
  type Endpoint,
  type EndpointInput,
  type EndpointOutput,
  enrollmentKeySchema,
  formatLocalDateTime,
  type LinkedAccount,
  type PreviewLinkResponse,
  type RemoteAccessStatus,
  routes,
} from '@orch/shared'
import { machineIdFromSecret } from './modules/access/access.service'
import { LinkedAccountRepository, linkedAccountPath } from './modules/remote-access/linked-account.repository'
import {
  RemoteAccessRepository,
  type RemoteAccessSettings,
  remoteAccessPath,
} from './modules/remote-access/remote-access.repository'
import {
  DEFAULT_SERVER_URL,
  enteredServerUrl,
  type RemoteAccessEnv,
} from './modules/remote-access/remote-access.service'
import { loadOrCreateMachineSecret, machineSecretFile } from './modules/tunnel/tunnel.repository'
import { parseServerUrl } from './modules/tunnel/tunnel.service'

// `bun run host:remote <command>`: the Remote access dialog for a terminal. A
// running host is the one owner of the setting, so every command goes through
// its local-only endpoints; only a host that refuses the connection is treated
// as stopped, and then the files in `.data/` are read and written directly.

/** A running host's answer: the parsed output, or the status and message of a refusal. */
export type HostAnswer<E extends Endpoint> =
  | { ok: true; data: EndpointOutput<E> }
  | { ok: false; status: number; message: string }

/** Calls a host endpoint. Null means no host is running: the connection was refused. */
export type CallHost = <E extends Endpoint>(endpoint: E, input: EndpointInput<E>) => Promise<HostAnswer<E> | null>

export interface RemoteCliDeps {
  callHost: CallHost
  /** The host's folder, holding `.data/`. */
  hostRoot: string
  /** The CLI's own environment. With the host stopped it only changes what `status` prints and adds hints. */
  env: RemoteAccessEnv
  /** Asks a question and answers the line typed. Null means the input ended. */
  prompt: (question: string) => Promise<string | null>
  out: (line: string) => void
  err: (line: string) => void
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

const USAGE = `Usage: bun run host:remote <command>

  status              Show the server address, remote access, the machine id and the linked account
  server <url>        Set the server address: wss://<host>, or ws:// on 127.0.0.1, [::1] or localhost
  on                  Turn remote access on
  off                 Turn remote access off
  link <key> [--yes]  Link this machine to an account with an enrollment key (needs the running host)
  unlink              Forget the linked account on this machine`

const FORGOTTEN =
  'The account is forgotten on this machine only. The server still lists the machine until you unlink it in the client.'

type Command =
  | { name: 'status' | 'unlink' }
  | { name: 'on' | 'off' }
  | { name: 'server'; url: string }
  | { name: 'link'; key: string; yes: boolean }

/** A command that changes the saved setting. */
type SettingCommand = Extract<Command, { name: 'server' | 'on' | 'off' }>

/** The command `args` names, or null when they don't make one. */
function parseArgs(args: string[]): Command | null {
  const [name, ...rest] = args
  if (name === 'status' || name === 'unlink') return rest.length === 0 ? { name } : null
  if (name === 'on' || name === 'off') return rest.length === 0 ? { name } : null
  if (name === 'server') return rest.length === 1 && rest[0] ? { name, url: rest[0] } : null
  if (name === 'link') {
    const yes = rest.includes('--yes')
    const keys = rest.filter((arg) => arg !== '--yes')
    return keys.length === 1 && keys[0] ? { name, key: keys[0], yes } : null
  }
  return null
}

/** Runs one `host:remote` command and answers its exit code. Nothing it prints holds a key or the machine secret. */
export async function runRemote(args: string[], deps: RemoteCliDeps): Promise<number> {
  const command = parseArgs(args)
  if (!command) {
    deps.err(USAGE)
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
  if (!status.ok) return refused(status, deps)
  return running(command, status.data, deps)
}

/** The commands against a running host, whose `status` is `current`. */
async function running(command: Command, current: RemoteAccessStatus, deps: RemoteCliDeps): Promise<number> {
  switch (command.name) {
    case 'status':
      printStatus(current, deps.out)
      return 0
    case 'server':
    case 'on':
    case 'off':
      return updateThroughHost(command, current, deps)
    case 'link':
      return linkThroughHost(command, deps)
    case 'unlink': {
      if (!current.linkedAccount) {
        deps.out('No account is linked')
        return 0
      }
      const answer = await deps.callHost(routes.remoteAccess.unlink, {})
      if (!answer?.ok) return refused(answer, deps)
      deps.out(FORGOTTEN)
      return 0
    }
  }
}

/** Sends one `update` that changes only what `command` names, keeping the rest of `current`. */
async function updateThroughHost(command: SettingCommand, current: RemoteAccessStatus, deps: RemoteCliDeps) {
  if (command.name === 'server' && current.serverUrlFromEnv) {
    deps.err('SERVER_URL sets the server address; change it there')
    return 1
  }
  // The host would overwrite a setting file it could not read, so the CLI refuses first.
  if (readSettings(deps) === false) return 1
  const keptServer = current.serverUrlIsDefault ? '' : current.serverUrl
  const answer = await deps.callHost(routes.remoteAccess.update, {
    enabled: command.name === 'server' ? current.enabled : command.name === 'on',
    serverUrl: command.name === 'server' ? command.url : keptServer,
    clientUrl: current.clientUrl,
  })
  if (!answer?.ok) return refused(answer, deps)
  if (command.name === 'server') deps.out(`Server address set to ${printable(answer.data.serverUrl)}.`)
  deps.out(remoteAccessLine(answer.data.enabled, answer.data.tunnel))
  if (command.name === 'on') deps.out('A newly created connect link is printed in the host log, not here.')
  return 0
}

/** Previews the key, asks unless `--yes` was given, then links with the previewed server address. */
async function linkThroughHost(command: Extract<Command, { name: 'link' }>, deps: RemoteCliDeps) {
  const preview = await deps.callHost(routes.remoteAccess.previewLink, { key: command.key })
  if (!preview?.ok) return refused(preview, deps)
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
  if (!linked?.ok) return refused(linked, deps)
  deps.out(`Linked: ${accountLine(linked.data.linkedAccount)}`)
  return 0
}

/** The commands with the host stopped, reading and writing `.data/` for its next start. */
function stopped(command: Command, deps: RemoteCliDeps): number {
  switch (command.name) {
    case 'status':
      return statusFromFiles(deps)
    case 'server':
    case 'on':
    case 'off':
      return saveSetting(command, deps)
    case 'link':
      deps.err('Start the host and turn remote access on, then run this again')
      return 1
    case 'unlink': {
      const file = linkedAccountPath(deps.hostRoot)
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

/** Prints `status` from the files, as the host would show it at its next start with this shell's `SERVER_URL`. */
function statusFromFiles(deps: RemoteCliDeps): number {
  const serverFromEnv = deps.env.SERVER_URL || undefined
  const settings = readSettings(deps)
  let account: LinkedAccount | null | undefined
  try {
    account = new LinkedAccountRepository(linkedAccountPath(deps.hostRoot)).load()
  } catch (error) {
    deps.err(messageOf(error))
  }
  const saved = settings || null
  const serverUrl = serverFromEnv ?? saved?.serverUrl ?? DEFAULT_SERVER_URL
  printStatus(
    {
      serverUrl,
      serverUrlIsDefault: isDefaultServer(serverUrl),
      serverUrlFromEnv: serverFromEnv !== undefined,
      enabled: settings === false ? null : Boolean(serverFromEnv) || Boolean(saved?.enabled),
      tunnel: 'host not running',
      machineId: readMachineId(deps),
      linkedAccount: account,
    },
    deps.out,
  )
  return settings === false || account === undefined ? 1 : 0
}

/** Rewrites only the field `command` names in `remote-access.json`. A missing file counts as off with no addresses. */
function saveSetting(command: SettingCommand, deps: RemoteCliDeps): number {
  const settings = readSettings(deps)
  if (settings === false) return 1
  const saved = settings ?? { enabled: false, serverUrl: null, clientUrl: null }
  const next: RemoteAccessSettings =
    command.name === 'server'
      ? { ...saved, serverUrl: enteredServerUrl(command.url) }
      : { ...saved, enabled: command.name === 'on' }
  new RemoteAccessRepository(remoteAccessPath(deps.hostRoot)).save(next)
  deps.out(
    command.name === 'server'
      ? `Server address saved: ${printable(next.serverUrl ?? '')}. The host uses it from its next start.`
      : `Remote access turned ${command.name}. The change applies when the host next starts.`,
  )
  if (deps.env.SERVER_URL && command.name !== 'on') {
    deps.out('SERVER_URL is set in this shell: a host started with it uses that address and turns remote access on.')
  }
  return 0
}

/** What `status` prints, from a running host or from the files. */
interface StatusView {
  serverUrl: string
  serverUrlIsDefault: boolean
  serverUrlFromEnv: boolean
  /** Null when the setting file could not be read. */
  enabled: boolean | null
  tunnel: string
  machineId: string | null
  /** Undefined when the linked account file could not be read. */
  linkedAccount: LinkedAccount | null | undefined
}

function printStatus(view: StatusView, out: (line: string) => void) {
  const marks = [view.serverUrlIsDefault && '(default)', view.serverUrlFromEnv && '(from SERVER_URL)'].filter(Boolean)
  out(`Server address: ${[printable(view.serverUrl), ...marks].join(' ')}`)
  out(view.enabled === null ? 'Remote access:  setting not readable' : remoteAccessLine(view.enabled, view.tunnel))
  out(`Machine id:     ${view.machineId === null ? 'none yet' : printable(view.machineId)}`)
  out(`Account:        ${view.linkedAccount === undefined ? 'not readable' : accountLine(view.linkedAccount)}`)
}

function remoteAccessLine(enabled: boolean, tunnel: string): string {
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

/** Prints a host's refusal and answers the exit code. Null stands for a host that went away mid-command. */
function refused(answer: { status: number; message: string } | null, deps: RemoteCliDeps): number {
  deps.err(answer ? printable(answer.message) : 'The host stopped. Run the command again')
  return 1
}

/** The saved setting, null when none is saved, or false after printing why the file is not valid. */
function readSettings(deps: RemoteCliDeps): RemoteAccessSettings | null | false {
  try {
    return new RemoteAccessRepository(remoteAccessPath(deps.hostRoot)).load()
  } catch (error) {
    deps.err(messageOf(error))
    return false
  }
}

/** The machine id from an existing secret. Never creates one, so `status` leaves `.data/` as it was. */
function readMachineId(deps: RemoteCliDeps): string | null {
  const file = machineSecretFile(deps.hostRoot)
  if (!existsSync(file)) return null
  try {
    return machineIdFromSecret(loadOrCreateMachineSecret(file))
  } catch (error) {
    // The repository's message never contains the secret.
    deps.err(messageOf(error))
    return null
  }
}

function isDefaultServer(serverUrl: string): boolean {
  const inUse = parseServerUrl(serverUrl)
  return inUse !== null && inUse === parseServerUrl(DEFAULT_SERVER_URL)
}

function messageOf(error: unknown): string {
  return printable(error instanceof Error ? error.message : String(error))
}

/**
 * `value` with every control character (C0, DEL and C1) replaced by `?`. Names
 * and messages come from the server or a file, and a terminal would run escape
 * sequences in them, which could rewrite the lines the user checks before linking.
 */
function printable(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
}
