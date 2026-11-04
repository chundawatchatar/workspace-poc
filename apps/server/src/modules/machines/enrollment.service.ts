import { type AnyPgDatabase, schema } from '@orch/domain'
import {
  type CreateEnrollmentResponse,
  enrollmentFingerprint,
  enrollmentKeySchema,
  type MachineFrame,
  type RelayKey,
  type ServerFrame,
} from '@orch/shared'
import { and, eq, gt, isNull } from 'drizzle-orm'
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
 * returned once; the row holds only its hash.
 */
export async function createEnrollment(
  machineEnrollments: UserData['machineEnrollments'],
  now: Date,
): Promise<CreateEnrollmentResponse> {
  const key = `oek_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS)
  await machineEnrollments.insert({ keyHash: hashEnrollmentKey(key), createdAt: now, expiresAt })
  return { key, fingerprint: enrollmentFingerprint(key), expiresAt: expiresAt.toISOString() }
}

/** The account an enrollment key belongs to, as a machine may see it. */
export interface EnrollmentAccount {
  name: string
  maskedEmail: string
}

/** What a preview shows about a key that still works. */
export interface EnrollmentPreview {
  account: EnrollmentAccount
  fingerprint: string
  expiresAt: string
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
 * Previews and redeems enrollment keys for machine tunnels. An unknown, used,
 * expired or malformed key all give null, so a caller can't tell them apart.
 * It never logs a key, a hash or an account.
 */
export class EnrollmentService {
  private readonly now: () => Date

  constructor(private readonly deps: EnrollmentServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** Which account `key` belongs to, without using it. Null means the key doesn't work. */
  async preview(key: string): Promise<EnrollmentPreview | null> {
    if (!enrollmentKeySchema.safeParse(key).success) return null
    const [row] = await this.deps
      .byKey()
      .select({ name: schema.user.name, email: schema.user.email, expiresAt: enrollments.expiresAt })
      .from(enrollments)
      .innerJoin(schema.user, eq(schema.user.id, enrollments.userId))
      .where(this.usable(key, this.now()))
      .limit(1)
    if (!row) return null
    return {
      account: { name: row.name, maskedEmail: maskEmail(row.email) },
      fingerprint: enrollmentFingerprint(key),
      expiresAt: row.expiresAt.toISOString(),
    }
  }

  /**
   * Uses `key` and links `machineId` to its owner under `name`, keeping the
   * name of a machine the owner already linked. Null means the key doesn't work.
   */
  async redeem(machineId: string, key: string, name: string): Promise<EnrollmentRedeemed | null> {
    if (!enrollmentKeySchema.safeParse(key).success) return null
    const db = this.deps.byKey()
    const now = this.now()
    // One conditional update, so of two redeems racing on one key exactly one gets the row back.
    const [used] = await db
      .update(enrollments)
      .set({ usedAt: now })
      .where(this.usable(key, now))
      .returning({ userId: enrollments.userId })
    if (!used) return null
    const { userId } = used
    await new MachinesService(this.deps.forUser({ userId }).machines, this.deps.registry).link(machineId, name)
    const [owner] = await db
      .select({ name: schema.user.name, email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .limit(1)
    if (!owner) throw new Error('The enrollment key owner is gone.')
    return {
      machineId,
      accountId: userId,
      account: { name: owner.name, maskedEmail: maskEmail(owner.email) },
      relayKeys: this.deps.relayKeys,
    }
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

/** The enrollment frames a machine sends. */
export type EnrollFrame = Extract<MachineFrame, { type: 'enroll.preview' | 'enroll.redeem' }>

/** What answering an enrollment frame needs. A missing `enrollment` means accounts are off. */
export interface EnrollmentFrameDeps {
  enrollment?: Pick<EnrollmentService, 'preview' | 'redeem'> | null
  limiter: ConnectionLimiter
}

/**
 * The answer to an enrollment frame from the tunnel of `machineId`, which
 * comes from the tunnel's proof and never from the frame. Accounts off gives
 * `unavailable`, and a machine out of enrollment tokens gets `rate_limited`
 * before the database is touched. It never rejects.
 */
export async function answerEnrollmentFrame(
  frame: EnrollFrame,
  machineId: string,
  { enrollment, limiter }: EnrollmentFrameDeps,
): Promise<ServerFrame> {
  const failed = (code: 'invalid_key' | 'rate_limited' | 'unavailable'): ServerFrame => ({
    type: 'enroll.failed',
    id: frame.id,
    code,
  })
  if (!enrollment) return failed('unavailable')
  if (!limiter.admitEnrollment(machineId).ok) return failed('rate_limited')
  try {
    if (frame.type === 'enroll.preview') {
      const preview = await enrollment.preview(frame.key)
      return preview ? { type: 'enroll.previewed', id: frame.id, ...preview } : failed('invalid_key')
    }
    const redeemed = await enrollment.redeem(machineId, frame.key, frame.name)
    return redeemed ? { type: 'enroll.redeemed', id: frame.id, ...redeemed } : failed('invalid_key')
  } catch {
    // A database error can quote its query's parameters, the key's hash among them, so the error itself is dropped.
    console.error('enrollment frame failed')
    return failed('unavailable')
  }
}
