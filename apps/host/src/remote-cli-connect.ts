import {
  accountEmailSchema,
  enrollmentFingerprint,
  enrollmentKeySchema,
  type RemoteAccessStatus,
  routes,
  sameServerUrl,
} from '@orch/shared'
import { enteredServerUrl, SERVER_URL_RULE } from './modules/remote-access/addresses.service'
import type { RemoteCliDeps } from './remote-cli'
import { printable, refused } from './remote-cli-output'

// `connect` and `disconnect`: the Connect and Disconnect buttons of the Remote
// access dialog, for a terminal. Both need the running host, which owns the
// tunnel. Nothing here prints the key, and the email only in the lines the
// owner checks before connecting.

export type ConnectCommand =
  | { name: 'connect'; email: string; key: string; server: string | null; yes: boolean }
  | { name: 'disconnect'; yes: boolean }

/** What the CLI says when the server didn't remove a disconnected machine from the account's list. */
export const REMOVE_IN_CLIENT =
  "The server did not remove this machine from your account's list. Remove it in the client, under Your machines."

const VALUE_FLAG = /^--(email|key|server)(?:=([\s\S]*))?$/

/**
 * The `connect` command from the words after it: `--email` and `--key` are
 * required, `--server` and `--yes` optional, each at most once. A flag takes
 * its value as the next word or after `=`. Null when they don't make one.
 */
export function parseConnectArgs(args: string[]): ConnectCommand | null {
  const values: { email?: string; key?: string; server?: string } = {}
  let yes = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--yes' && !yes) {
      yes = true
      continue
    }
    const match = VALUE_FLAG.exec(arg)
    const name = match?.[1] as keyof typeof values | undefined
    if (!name || values[name] !== undefined) return null
    const value = match?.[2] ?? args[++i]
    if (value === undefined) return null
    values[name] = value
  }
  const { email, key, server } = values
  if (email === undefined || key === undefined) return null
  return { name: 'connect', email, key, server: server ?? null, yes }
}

/** The `disconnect` command from the words after it, or null when they don't make one. */
export function parseDisconnectArgs(args: string[]): ConnectCommand | null {
  if (args.length === 0) return { name: 'disconnect', yes: false }
  return args.length === 1 && args[0] === '--yes' ? { name: 'disconnect', yes: true } : null
}

/** Why a `connect` would be refused before the host is called, or null when its values look right. Never quotes one. */
export function connectProblem(command: Extract<ConnectCommand, { name: 'connect' }>): string | null {
  if (!enrollmentKeySchema.safeParse(command.key).success) {
    return 'That is not an enrollment key. Copy the command again from Connect a machine in the client'
  }
  if (!accountEmailSchema.safeParse(command.email).success) return 'That is not an email address'
  if (command.server !== null && !safely(() => enteredServerUrl(command.server ?? ''))) return SERVER_URL_RULE
  return null
}

/**
 * Connects through the running host whose status is `current`: shows the
 * server, the email and the key's last 4 characters, asks unless `--yes` was
 * given, then sends Connect. Without `--server` it uses the built-in default,
 * or the address a flag or variable sets, which a different `--server` can't change.
 */
export async function connectThroughHost(
  command: Extract<ConnectCommand, { name: 'connect' }>,
  current: RemoteAccessStatus,
  deps: RemoteCliDeps,
): Promise<number> {
  if (current.linkedAccount) {
    deps.err(`This machine is already connected to ${accountName(current)}. Disconnect it first`)
    return 1
  }
  const setBy = current.serverUrlSetBy
  if (setBy && command.server !== null && !sameServerUrl(command.server, current.serverUrl)) {
    deps.err(`${printable(setBy)} sets the server address to ${printable(current.serverUrl)}. Leave out --server`)
    return 1
  }
  const server = setBy ? current.serverUrl : (command.server?.trim() ?? current.defaultServerUrl)
  const email = accountEmailSchema.parse(command.email)
  deps.out(`Server:      ${printable(server)}`)
  if (!sameServerUrl(server, current.defaultServerUrl)) {
    deps.out('Warning:     this is not the default server. Connect only if you run it or trust who does.')
  }
  deps.out(`Email:       ${printable(email)}`)
  deps.out(`Key ends in: ${printable(enrollmentFingerprint(command.key))}`)
  if (!(await confirmed(command.yes, 'Connect this machine to this account? [y/N] ', 'Not connected', deps))) return 1
  deps.out('Connecting...')
  const answer = await deps.callHost(routes.remoteAccess.connect, { email, key: command.key, serverUrl: server })
  if (!answer?.ok) return refused(answer, deps.err)
  deps.out(`Connected to ${accountName(answer.data)} through ${printable(server)}`)
  return 0
}

/**
 * Disconnects through the running host whose status is `current`, asking
 * unless `--yes` was given, and says when the owner still has to remove the
 * machine in the client. A machine that is not connected is left alone.
 */
export async function disconnectThroughHost(
  command: Extract<ConnectCommand, { name: 'disconnect' }>,
  current: RemoteAccessStatus,
  deps: RemoteCliDeps,
): Promise<number> {
  if (!current.linkedAccount) {
    deps.out('This machine is not connected')
    return 0
  }
  const question = `Disconnect this machine from ${accountName(current)}? [y/N] `
  if (!(await confirmed(command.yes, question, 'Still connected', deps))) return 1
  const answer = await deps.callHost(routes.remoteAccess.disconnect, {})
  if (!answer?.ok) return refused(answer, deps.err)
  deps.out('Disconnected. The account and its approved browsers are forgotten on this machine.')
  if (!answer.data.removedFromAccount) deps.out(REMOVE_IN_CLIENT)
  return 0
}

/** True when `yes` was given or the owner typed y or yes. Any other answer prints `refusal`. */
async function confirmed(yes: boolean, question: string, refusal: string, deps: RemoteCliDeps): Promise<boolean> {
  if (yes) return true
  const answer = await deps.prompt(question)
  if (answer === null) {
    deps.err('No answer could be read, so nothing was sent. Run this in a terminal, or add --yes.')
    return false
  }
  if (/^(y|yes)$/i.test(answer.trim())) return true
  deps.err(refusal)
  return false
}

/** The connected account as the owner recognises it: its name and masked email. */
function accountName(status: RemoteAccessStatus): string {
  const account = status.linkedAccount
  return account ? `${printable(account.name)} (${printable(account.maskedEmail)})` : 'no account'
}

function safely(check: () => unknown): boolean {
  try {
    check()
    return true
  } catch {
    return false
  }
}
