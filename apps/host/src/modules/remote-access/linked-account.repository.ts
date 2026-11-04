import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type LinkedAccount, linkedAccount } from '@orch/shared'
import { writeJsonAtomic } from './remote-access.repository'

/** Where the account this machine is linked to is kept. */
export function linkedAccountPath(hostRoot: string) {
  return join(hostRoot, '.data', 'linked-account.json')
}

/** Loads, saves and removes the linked account in one JSON file. It holds the account, never an enrollment key. */
export class LinkedAccountRepository {
  constructor(readonly file: string) {}

  /** The linked account, or null when the file does not exist. A file that is not valid throws and is left as it is. */
  load(): LinkedAccount | null {
    if (!existsSync(this.file)) return null
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      value = undefined
    }
    const parsed = linkedAccount.strict().safeParse(value)
    if (!parsed.success) throw new Error(`the linked account in ${this.file} is not valid. Delete the file to unlink`)
    return parsed.data
  }

  /** Replaces the file in one step, keeping only the account's fields. */
  save(account: LinkedAccount) {
    const { name, maskedEmail, serverUrl, linkedAt } = account
    writeJsonAtomic(this.file, { name, maskedEmail, serverUrl, linkedAt })
  }

  /** Removes the file. A missing file is fine. */
  remove() {
    rmSync(this.file, { force: true })
  }
}
