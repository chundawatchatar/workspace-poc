import { type AnyPgDatabase, schema } from '@orch/domain'
import {
  accountEmailSchema,
  type CreateEnrollmentResponse,
  enrollmentFingerprint,
  enrollmentKeySchema,
  type MachineFrame,
  type RelayKey,
  type ServerFrame,
} from '@orch/shared'
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { ForUser, UserData } from '../../lib/createServerRouter'
import type { ConnectionLimiter } from '../limits/limits.service'
import type { MachineRegistry } from '../tunnel/tunnel.service'
import { MachinesService } from './machines.service'

/** How long an enrollment key works after it is created. */
export const ENROLLMENT_TTL_MS = 15 * 60 * 1000

/** The fixed reason logged on each key lookup. It never holds the key, its hash or the account. */
export const ENROLLMENT_LOOKUP_REASON = 'enrollment key lookup by hash from a machine tunnel'

const enrollments = schema.machineEnrollments

/** The SHA-256 of an enrollment key, as lowercase hex. Only this is stored. */
export function hashEnrollmentKey(key: string): string {
  return new Bun.CryptoHasher('sha256').update(key).digest('hex')
}

/** An email with only the first character of its local part kept: `a***@example.com`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return '***'
  return `${email[0]}***@${email.slice(at + 1)}`
}

/**
 * Creates an enrollment key for the signed-in user, valid for
 * `ENROLLMENT_TTL_MS` from `now`. The key carries 256 random bits and is
 * returned once, with `serverUrl`, the address machines open their tunnel to;
 * the row holds only its hash.
 */
export async function createEnrollment(
  machineEnrollments: UserData['machineEnrollments'],
  now: Date,
  serverUrl: string,
): Promise<CreateEnrollmentResponse> {
  const key = `oek_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS)
  await machineEnrollments.insert({ keyHash: hashEnrollmentKey(key), createdAt: now, expiresAt })
  return { key, fingerprint: enrollmentFingerprint(key), expiresAt: expiresAt.toISOString(), serverUrl }
}

/** The account an enrollment key belongs to, as a machine may see it. */
export interface EnrollmentAccount {
  name: string
  maskedEmail: string
}

/**
 * What redeeming a key did: `machineId` is now linked to `account`, whose user
 * id is `accountId`, and should trust relay tickets signed by `relayKeys`.
 */
export interface EnrollmentRedeemed {
  machineId: string
  accountId: string
  account: EnrollmentAccount
  relayKeys: RelayKey[]
}

/** What the enrollment service needs. */
export interface EnrollmentServiceDeps {
  /**
   * The raw client, for lookups that start from a key rather than a
   * principal. `index.ts` passes `() => domain.skipAuthorization(ENROLLMENT_LOOKUP_REASON)`,
   * so every lookup is logged with the fixed reason.
   */
  byKey: () => AnyPgDatabase
  /** Opens the key owner's scoped repositories, which linking goes through. */
  forUser: ForUser
  /** The registry the linked machine's online state is read from. */
  registry: MachineRegistry
  /** The server's relay public keys, handed to every machine that links. */
  relayKeys: RelayKey[]
  /** The clock. Defaults to the current time. */
  now?: () => Date
}

/**
 * Redeems enrollment keys for machine tunnels, and removes a machine from an
 * account's list at the machine's own request. An unknown, used, expired or
 * malformed key, and an email that isn't the key owner's, all give null, so a
 * caller can't tell them apart. It never logs a key, a hash, an email or an account.
 */
export class EnrollmentService {
  private readonly now: () => Date

  constructor(private readonly deps: EnrollmentServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Uses `key` and links `machineId` to its owner under `name`, keeping the
   * name of a machine the owner already linked, when `email` is the owner's,
   * in any letter case and with any spaces around it. Null means the key
   * doesn't work or the email doesn't match, which leaves the key unused.
   */
  async redeem(machineId: string, key: string, email: string, name: string): Promise<EnrollmentRedeemed | null> {
    const owner = accountEmailSchema.safeParse(email)
    if (!enrollmentKeySchema.safeParse(key).success || !owner.success) return null
    const db = this.deps.byKey()
    const now = this.now()
    // One conditional update, so of two redeems racing on one key exactly one gets the row back, and a key sent
    // with another email stays unused.
    const ownerIds = db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(sql`lower(${schema.user.email})`, owner.data.toLowerCase()))
    const [used] = await db
      .update(enrollments)
      .set({ usedAt: now })
      .where(and(this.usable(key, now), inArray(enrollments.userId, ownerIds)))
      .returning({ userId: enrollments.userId })
    if (!used) return null
    const { userId } = used
    await new MachinesService(this.deps.forUser({ userId }).machines, this.deps.registry).link(machineId, name)
    const [account] = await db
      .select({ name: schema.user.name, email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .limit(1)
    if (!account) throw new Error('The enrollment key owner is gone.')
    return {
      machineId,
      accountId: userId,
      account: { name: account.name, maskedEmail: maskEmail(account.email) },
      relayKeys: this.deps.relayKeys,
    }
  }

  /**
   * Removes `machineId` from the list of the account `accountId`, through
   * that account's scoped repository, so no other account's row and no other
   * machine's can go. Nothing happens when the account doesn't list it.
   */
  async unlink(machineId: string, accountId: string): Promise<void> {
    await new MachinesService(this.deps.forUser({ userId: accountId }).machines, this.deps.registry).unlink(machineId)
  }

  /** The rows `key` matches while it is unused and unexpired at `now`. */
  private usable(key: string, now: Date) {
    return and(
      eq(enrollments.keyHash, hashEnrollmentKey(key)),
      isNull(enrollments.usedAt),
      gt(enrollments.expiresAt, now),
    )
  }
}

/** What answering a machine's account frames needs. A missing `enrollment` means accounts are off. */
export interface EnrollmentFrameDeps {
  enrollment?: Pick<EnrollmentService, 'redeem' | 'unlink'> | null
  limiter: ConnectionLimiter
}

type Refusal = 'rate_limited' | 'unavailable'

/**
 * Runs `answer` for a frame from the tunnel of `machineId`, unless accounts
 * are off (`unavailable`) or the machine is out of enrollment tokens
 * (`rate_limited`), which is decided before the database is touched. A
 * failure answers `unavailable` too. It never rejects.
 */
async function guarded(
  machineId: string,
  { enrollment, limiter }: EnrollmentFrameDeps,
  refuse: (code: Refusal) => ServerFrame,
  answer: (enrollment: NonNullable<EnrollmentFrameDeps['enrollment']>) => Promise<ServerFrame>,
): Promise<ServerFrame> {
  if (!enrollment) return refuse('unavailable')
  if (!limiter.admitEnrollment(machineId).ok) return refuse('rate_limited')
  try {
    return await answer(enrollment)
  } catch {
    // A database error can quote its query's parameters, the key's hash and the email among them, so the error
    // itself is dropped.
    console.error('account frame failed')
    return refuse('unavailable')
  }
}

/**
 * The answer to `enroll.redeem` from the tunnel of `machineId`, which comes
 * from the tunnel's proof and never from the frame. A key that doesn't work
 * and an email that isn't its owner's get the same `invalid_key`.
 */
export function answerEnrollmentFrame(
  frame: Extract<MachineFrame, { type: 'enroll.redeem' }>,
  machineId: string,
  deps: EnrollmentFrameDeps,
): Promise<ServerFrame> {
  const failed = (code: 'invalid_key' | Refusal): ServerFrame => ({ type: 'enroll.failed', id: frame.id, code })
  return guarded(machineId, deps, failed, async (enrollment) => {
    const redeemed = await enrollment.redeem(machineId, frame.key, frame.email, frame.name)
    return redeemed ? { type: 'enroll.redeemed', id: frame.id, ...redeemed } : failed('invalid_key')
  })
}

/**
 * The answer to `unlink` from the tunnel of `machineId`: it removes that
 * machine, never one the frame names, from the list of the account the frame
 * names, and answers `unlinked` whether or not the account listed it. It
 * counts against the machine's enrollment tokens.
 */
export function answerUnlinkFrame(
  frame: Extract<MachineFrame, { type: 'unlink' }>,
  machineId: string,
  deps: EnrollmentFrameDeps,
): Promise<ServerFrame> {
  const failed = (code: Refusal): ServerFrame => ({ type: 'unlink.failed', id: frame.id, code })
  return guarded(machineId, deps, failed, async (enrollment) => {
    await enrollment.unlink(machineId, frame.accountId)
    return { type: 'unlinked', id: frame.id }
  })
}
