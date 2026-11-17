// The command the "Connect a machine" dialog shows, for the owner to run on the machine they connect.

/** Characters no common shell (sh, bash, zsh, fish) treats specially inside a word. */
const PLAIN_WORD = /^[A-Za-z0-9@._+:/-]+$/

/** `value` as one shell word: as it is when it holds only plain characters, else single-quoted. */
export function shellWord(value: string): string {
  return PLAIN_WORD.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

/** What a machine needs to connect itself: the signed-in account's email, a new key and the server's tunnel address. */
export interface ConnectCommandInput {
  email: string
  key: string
  serverUrl: string
}

/** The `corch connect` command that connects a machine to the signed-in account with a new enrollment key. */
export function connectCommand({ email, key, serverUrl }: ConnectCommandInput): string {
  return `corch connect --email ${shellWord(email)} --key ${shellWord(key)} --server ${shellWord(serverUrl)}`
}
