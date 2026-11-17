import { type AnyPgDatabase, schema } from '@orch/domain'
import {
  accountEmailSchema,
  type ConnectRequest,
  type CreateEnrollmentResponse,
  enrollmentFingerprint,
  enrollmentKeySchema,
  type MachineFrame,
  type RelayKey,
  type ServerFrame,
  type ServerMachine,
} from '@orch/shared'
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { ForUser, SessionPrincipal, UserData } from '../../lib/createServerRouter'
import type { ConnectionLimiter } from '../limits/limits.service'
import type { MachineConnection, MachineRegistry } from '../tunnel/tunnel.service'
import type { ConnectRequests, WaitingRequest } from './connect-requests.service'
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
 * returned once, with its row's `id`, which is also the id of the request a
 * machine makes with it, and `serverUrl`, the address machines open their
 * tunnel to; the row holds only its hash.
 */
export async function createEnrollment(
  machineEnrollments: UserData['machineEnrollments'],
  now: Date,
  serverUrl: string,
): Promise<CreateEnrollmentResponse> {
  const key = `oek_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS)
  const { id } = await machineEnrollments.insert({ keyHash: hashEnrollmentKey(key), createdAt: now, expiresAt })
  return { id, key, fingerprint: enrollmentFingerprint(key), expiresAt: expiresAt.toISOString(), serverUrl }
}

/** What the enrollment service needs. */
export interface EnrollmentServiceDeps {
  /**
   * The raw client, for lookups that start from a key rather than a
   * principal. `index.ts` passes `() => domain.skipAuthorization(ENROLLMENT_LOOKUP_REASON)`,
   * so every lookup is logged with the fixed reason.
   */
  byKey: () => AnyPgDatabase
  /** Opens an account's scoped repositories, which unlinking goes through. */
  forUser: ForUser
  /** The registry the unlinked machine's online state is read from. */
  registry: MachineRegistry
  /** Where each request waits for the owner's answer, shared with the machines module that answers it. */
  requests: ConnectRequests
  /** The clock. Defaults to the current time. */
  now?: () => Date
}

/**
 * Takes the connect requests machine tunnels make with enrollment keys and
 * holds each one for its owner, and removes a machine from an account's list
 * at the machine's own request. An unknown, used, expired or malformed key, an
 * email that isn't the key owner's and a key another machine asked with all
 * give null, so a caller can't tell them apart. It never logs a key, a hash,
 * an email or an account.
 */
export class EnrollmentService {
  private readonly now: () => Date

  constructor(private readonly deps: EnrollmentServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Records on `key`'s row that the machine of `conn` asks to be linked to the
   * key's owner under `name`, when `email` is the owner's, in any letter case
   * and with any spaces around it, and holds the request in `requests` with
   * the frame's `frameId`. The key stays unused until the owner answers. The
   * same machine may ask again with the same key, after a cancel or a restart
   * lost its request; any other machine can't. Answers the key's time left in
   * milliseconds, or null when the key doesn't work for this machine or the
   * email doesn't match, which leaves the row as it was.
   */
  async request(
    conn: MachineConnection,
    frameId: number,
    key: string,
    email: string,
    name: string,
  ): Promise<{ expiresInMs: number } | null> {
    const owner = accountEmailSchema.safeParse(email)
    if (!enrollmentKeySchema.safeParse(key).success || !owner.success) return null
    const { machineId } = conn
    const db = this.deps.byKey()
    const now = this.now()
    // One conditional update, so a key sent with another email, or one another machine already asked with, stays as
    // it was, and of two machines racing on one fresh key exactly one gets it.
    const ownerIds = db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(sql`lower(${schema.user.email})`, owner.data.toLowerCase()))
    const [held] = await db
      .update(enrollments)
      .set({ requestMachineId: machineId, requestName: name, requestedAt: now })
      .where(
        and(
          this.usable(key, now),
          inArray(enrollments.userId, ownerIds),
          or(isNull(enrollments.requestMachineId), eq(enrollments.requestMachineId, machineId)),
        ),
      )
      .returning({ id: enrollments.id, expiresAt: enrollments.expiresAt })
    if (!held) return null
    this.deps.requests.hold({ id: held.id, conn, frameId, machineId, expiresAt: held.expiresAt })
    return { expiresInMs: Math.max(0, held.expiresAt.getTime() - now.getTime()) }
  }

  /** Ends the request the tunnel `conn` holds, for its closing. */
  connectionClosed(conn: MachineConnection): void {
    this.deps.requests.connectionClosed(conn)
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
  enrollment?: Pick<EnrollmentService, 'request' | 'unlink'> | null
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
 * The first answer to `enroll.request` from the tunnel `conn`, whose machine
 * id comes from the tunnel's proof and never from the frame: `enroll.waiting`
 * with the key's time left once the request is held for the owner, else
 * `enroll.failed`. A key that doesn't work for this machine and an email that
 * isn't its owner's get the same `invalid_key`.
 */
export function answerEnrollmentFrame(
  frame: Extract<MachineFrame, { type: 'enroll.request' }>,
  conn: MachineConnection,
  deps: EnrollmentFrameDeps,
): Promise<ServerFrame> {
  const failed = (code: 'invalid_key' | Refusal): ServerFrame => ({ type: 'enroll.failed', id: frame.id, code })
  return guarded(conn.machineId, deps, failed, async (enrollment) => {
    const held = await enrollment.request(conn, frame.id, frame.key, frame.email, frame.name)
    return held ? { type: 'enroll.waiting', id: frame.id, expiresInMs: held.expiresInMs } : failed('invalid_key')
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

/** What the owner's answers to connect requests need, besides the owner's own repositories. */
export interface ConnectAnswerDeps {
  /** The requests waiting for an answer, shared with the enrollment service that holds them. */
  requests: ConnectRequests
  /** The registry the linked machine's online state is read from. */
  registry: MachineRegistry
  /** The server's relay public keys, handed to every machine that links. */
  relayKeys: RelayKey[]
  now: Date
}

/**
 * The owner's waiting connect requests, newest first: the rows of their own
 * enrollment keys that hold a request and are unused and unexpired at `now`,
 * kept only while the request still waits on the same machine's tunnel, so a
 * row a closed tunnel or a restart left behind is never listed. It changes
 * nothing.
 */
export async function listConnectRequests(
  data: UserData,
  requests: ConnectRequests,
  now: Date,
): Promise<ConnectRequest[]> {
  const rows = await data.machineEnrollments.list(
    and(isNotNull(enrollments.requestMachineId), isNull(enrollments.usedAt), gt(enrollments.expiresAt, now)),
  )
  rows.sort((a, b) => (b.requestedAt?.getTime() ?? 0) - (a.requestedAt?.getTime() ?? 0))
  return rows.flatMap((row) => {
    const waiting = requests.waiting(row.id, now)
    if (!waiting || waiting.machineId !== row.requestMachineId || !row.requestedAt) return []
    return [
      {
        id: row.id,
        machineId: waiting.machineId,
        name: row.requestName ?? '',
        requestedAt: row.requestedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      },
    ]
  })
}

/** Why an answer to a connect request was refused: not one of the owner's, or not waiting any more. */
export type AnswerRefusal = 'not_found' | 'not_waiting'

/**
 * Accepts the owner's waiting request `id`: uses up its key, links the
 * machine to the owner under the name it asked with, and sends
 * `enroll.redeemed` on the waiting tunnel. Answers the linked machine, or why
 * it refused, which changes nothing and sends nothing.
 */
export async function acceptConnectRequest(
  id: string,
  principal: SessionPrincipal,
  data: UserData,
  deps: ConnectAnswerDeps,
): Promise<ServerMachine | AnswerRefusal> {
  const taken = await takeRequest(id, data, deps)
  if (typeof taken === 'string') return taken
  const { row, waiting } = taken
  const machine = await new MachinesService(data.machines, deps.registry).link(
    waiting.machineId,
    row.requestName ?? 'this machine',
  )
  waiting.conn.send({
    type: 'enroll.redeemed',
    id: waiting.frameId,
    machineId: waiting.machineId,
    accountId: principal.userId,
    account: { name: principal.name, maskedEmail: maskEmail(principal.email) },
    relayKeys: deps.relayKeys,
  })
  return machine
}

/**
 * Rejects the owner's waiting request `id`: uses up its key, links nothing
 * and sends `enroll.failed` with `rejected` on the waiting tunnel. Answers
 * null, or why it refused, which changes nothing and sends nothing.
 */
export async function rejectConnectRequest(
  id: string,
  data: UserData,
  deps: ConnectAnswerDeps,
): Promise<AnswerRefusal | null> {
  const taken = await takeRequest(id, data, deps)
  if (typeof taken === 'string') return taken
  taken.waiting.conn.send({ type: 'enroll.failed', id: taken.waiting.frameId, code: 'rejected' })
  return null
}

/**
 * Uses up the key of the owner's request `id` while it still waits, and ends
 * the request. One conditional update, so of two answers racing on one request
 * exactly one gets it. Another user's id is `not_found`, through the scoped
 * repository; a used or expired key, or a request whose tunnel is gone, is
 * `not_waiting`.
 */
async function takeRequest(
  id: string,
  data: UserData,
  { requests, now }: ConnectAnswerDeps,
): Promise<{ row: typeof enrollments.$inferSelect; waiting: WaitingRequest } | AnswerRefusal> {
  const row = await data.machineEnrollments.find(eq(enrollments.id, id))
  if (!row) return 'not_found'
  const waiting = requests.waiting(id, now)
  if (!waiting || row.requestMachineId !== waiting.machineId) return 'not_waiting'
  const [used] = await data.machineEnrollments.update(
    and(
      eq(enrollments.id, id),
      isNull(enrollments.usedAt),
      gt(enrollments.expiresAt, now),
      eq(enrollments.requestMachineId, waiting.machineId),
    ),
    { usedAt: now },
  )
  if (!used) return 'not_waiting'
  requests.end(waiting)
  return { row: used, waiting }
}
