import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { linkedAccount, relayKeyList } from '@orch/shared'
import { z } from 'zod'
import { writeJsonAtomic } from './remote-access.repository'

/**
 * The linked account as this machine keeps it: what the status shows, plus
 * `accountId`, the user id relay tickets must name, and `relayKeys`, the
 * server's public keys they must be signed with. A file written before
 * account access has neither, and grants no account access.
 */
const savedLinkedAccount = linkedAccount
  .extend({ accountId: z.string().min(1).optional(), relayKeys: relayKeyList.optional() })
  .strict()

export type SavedLinkedAccount = z.infer<typeof savedLinkedAccount>

/** Where the account this machine is linked to is kept. */
export function linkedAccountPath(hostRoot: string) {
  return join(hostRoot, '.data', 'linked-account.json')
}

/** Loads, saves and removes the linked account in one JSON file. It holds the account, never an enrollment key. */
export class LinkedAccountRepository {
  constructor(readonly file: string) {}

  /** The linked account, or null when the file does not exist. A file that is not valid throws and is left as it is. */
  load(): SavedLinkedAccount | null {
    if (!existsSync(this.file)) return null
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      value = undefined
    }
    const parsed = savedLinkedAccount.safeParse(value)
    if (!parsed.success) throw new Error(`the linked account in ${this.file} is not valid. Delete the file to unlink`)
    return parsed.data
  }

  /** Replaces the file in one step, keeping only the account's fields. */
  save(account: SavedLinkedAccount) {
    const { name, maskedEmail, serverUrl, linkedAt, accountId, relayKeys } = account
    writeJsonAtomic(this.file, { name, maskedEmail, serverUrl, linkedAt, accountId, relayKeys })
  }

  /** Removes the file. A missing file is fine. */
  remove() {
    rmSync(this.file, { force: true })
  }
}
