import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type AgentTrackingStatus, agentTrackingAnswer, trackedAgent } from '@orch/shared'
import { z } from 'zod'

/** The file as saved: an answer per agent kind that was asked. It never holds tokens. */
const savedAnswers = z.object(
  Object.fromEntries(trackedAgent.options.map((kind) => [kind, agentTrackingAnswer.optional()])) as Record<
    (typeof trackedAgent.options)[number],
    z.ZodOptional<typeof agentTrackingAnswer>
  >,
)

/** The answers when nothing was asked yet. */
export function unanswered(): AgentTrackingStatus {
  return { claude: null, codex: null }
}

/** Where the trust answers are kept. */
export function agentTrackingPath(hostRoot: string) {
  return join(hostRoot, '.data', 'agent-tracking.json')
}

/** Loads and saves the user's trust answers in one private JSON file. */
export class AgentTrackingRepository {
  constructor(readonly file: string) {}

  /**
   * The saved answers. A missing file reads as all null, and so does a damaged one: it only ever turns tracking
   * off, and the next answer replaces it.
   */
  load(): AgentTrackingStatus {
    if (!existsSync(this.file)) return unanswered()
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      value = undefined
    }
    const parsed = savedAnswers.safeParse(value)
    if (!parsed.success) {
      console.warn(`the agent tracking answers in ${this.file} are not valid; asking again`)
      return unanswered()
    }
    return { ...unanswered(), ...parsed.data }
  }

  /** Replaces the file in one step, so a crash never leaves half of it. Unasked kinds are left out. */
  save(answers: AgentTrackingStatus) {
    const saved = Object.fromEntries(Object.entries(answers).filter(([, answer]) => answer !== null))
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      // The mode above is masked by the umask; this sets it exactly.
      chmodSync(temp, 0o600)
      renameSync(temp, this.file)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }
}
