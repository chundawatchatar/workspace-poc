import type {
  enrollFailedFrame,
  enrollRedeemedFrame,
  enrollRequestFrame,
  enrollWaitingFrame,
  MachineFrame,
  unlinkedFrame,
  unlinkFailedFrame,
  unlinkFrame,
} from '@orch/shared'
import type { z } from 'zod'

/** An `enroll.request` frame to send, without its `id`, which the client picks. */
export type EnrollRequest = Omit<z.infer<typeof enrollRequestFrame>, 'id'>

/** The owner's final answer to an `EnrollRequest`: `enroll.redeemed`, or `enroll.failed` with `rejected`. */
export type EnrollAnswer = z.infer<typeof enrollRedeemedFrame> | z.infer<typeof enrollFailedFrame>

/**
 * The server holds an `EnrollRequest` for the owner: `expiresInMs` is the
 * key's time left, and `answer` resolves with the owner's final answer, or
 * rejects when the connection ends first. A rejection nobody waits for is
 * not an unhandled one.
 */
export type EnrollWaiting = z.infer<typeof enrollWaitingFrame> & { answer: Promise<EnrollAnswer> }

/** The server's first answer to an `EnrollRequest`: it waits for the owner, or `enroll.failed`. */
export type EnrollStart = EnrollWaiting | z.infer<typeof enrollFailedFrame>

/** The server's answer to `unlink`: `unlinked`, or `unlink.failed`. */
export type UnlinkAnswer = z.infer<typeof unlinkedFrame> | z.infer<typeof unlinkFailedFrame>

/** A frame that asks the server something, without its `id`, which the client picks. */
export type AskFrame = EnrollRequest | Omit<z.infer<typeof unlinkFrame>, 'id'>

/** A server frame that answers an ask. */
export type AskAnswerFrame = EnrollAnswer | UnlinkAnswer | z.infer<typeof enrollWaitingFrame>

/** What an ask resolves with: an answer frame, or a waiting request with its final answer to come. */
type Received = EnrollStart | EnrollAnswer | UnlinkAnswer

/** The answers each asking frame waits for first. Any other frame with its id is ignored. */
const ANSWERS: Record<AskFrame['type'], readonly AskAnswerFrame['type'][]> = {
  'enroll.request': ['enroll.waiting', 'enroll.failed'],
  unlink: ['unlinked', 'unlink.failed'],
}

/** The final answers to an `enroll.request` the server holds, after its `enroll.waiting`. */
const FINAL_ANSWERS: readonly AskAnswerFrame['type'][] = ['enroll.redeemed', 'enroll.failed']

/** A frame waiting for its answer. */
interface PendingAsk {
  answers: readonly AskAnswerFrame['type'][]
  resolve: (received: Received) => void
  reject: (error: Error) => void
  /** Rejects the ask when the server takes too long. None for a final answer, which waits for the owner. */
  timer?: Timer
}

/**
 * The frames one tunnel connection asked the server something with, by id,
 * until they are answered, time out or the connection ends, then each
 * request the server holds, until the owner's final answer or the
 * connection's end.
 */
export class TunnelAsks {
  private readonly pending = new Map<number, PendingAsk>()

  /** `send` sends a frame on the connection, and the server has `timeoutMs` to answer each ask. */
  constructor(
    private readonly send: (frame: MachineFrame) => void,
    private readonly timeoutMs: number,
  ) {}

  /** Sends `frame` with `id` and resolves with the first of its answers that comes back with that id. */
  ask(id: number, frame: AskFrame): Promise<Received> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('the server did not answer'))
      }, this.timeoutMs)
      this.pending.set(id, { answers: ANSWERS[frame.type], resolve, reject, timer })
      this.send({ ...frame, id })
    })
  }

  /** Takes an answer frame. One that answers nothing waiting with its id, or is of the wrong kind, is ignored. */
  receive(frame: AskAnswerFrame): void {
    const pending = this.pending.get(frame.id)
    if (!pending?.answers.includes(frame.type)) return
    this.pending.delete(frame.id)
    clearTimeout(pending.timer)
    if (frame.type === 'enroll.waiting') pending.resolve({ ...frame, answer: this.finalAnswer(frame.id) })
    else pending.resolve(frame)
  }

  /** Rejects every ask and every wait for an owner's answer, for the connection's end. */
  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('the tunnel closed'))
    }
    this.pending.clear()
  }

  /**
   * Waits for the owner's final answer to the request `id`, which the server
   * holds. It is waiting before the caller hears of the request, so an answer
   * can't come too early to be heard.
   */
  private finalAnswer(id: number): Promise<EnrollAnswer> {
    const answer = new Promise<EnrollAnswer>((resolve, reject) => {
      // Only the final answers resolve it, so the cast names what `FINAL_ANSWERS` lets through.
      this.pending.set(id, { answers: FINAL_ANSWERS, resolve: (received) => resolve(received as EnrollAnswer), reject })
    })
    answer.catch(() => {})
    return answer
  }
}
