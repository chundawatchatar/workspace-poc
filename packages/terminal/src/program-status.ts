import type { AgentReport } from '@orch/agents/runtime'

/**
 * The Program Status Protocol: a program writes
 * `ESC ] 7501 ; state=<state>[:kind=<kind>][:app=…][:msg=…] ST` into its own
 * terminal output to say what it is doing. Codex, Claude Code and pi speak it.
 * This is the one place it is read, for every agent alike; an agent that doesn't
 * speak it has no status.
 */
export const PROGRAM_STATUS_OSC = 7501

/**
 * The answer to `ESC ] 7501 ; ? ST`, which Claude Code and pi send at start to
 * ask whether the terminal supports the protocol: the same body back. They
 * report only once it arrives, and only if it comes before the answer to the
 * device-attributes query they send after it, so it is answered from the raw
 * output with `statusQueries`, before anything else sees those bytes.
 */
export const PROGRAM_STATUS_REPLY = '\x1b]7501;?\x1b\\'

const QUERY = Buffer.from('\x1b]7501;?')

/**
 * How many support questions start in `chunk`, a piece of a program's raw
 * output, and the tail to pass with the next piece, so a question split across
 * two pieces still counts once. It reads bytes before any parsing, so the answer
 * goes out before a browser view, which gets the same bytes at once, can send its
 * own answers to the queries that follow.
 */
export function statusQueries(tail: Uint8Array, chunk: Uint8Array): { count: number; tail: Uint8Array } {
  const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  // Only `QUERY.length - 1` bytes of the chunk join the seam, so a match there starts in the tail: never counted twice.
  const seam = Buffer.concat([tail, bytes.subarray(0, QUERY.length - 1)])
  let count = seam.includes(QUERY) ? 1 : 0
  for (let at = bytes.indexOf(QUERY); at !== -1; at = bytes.indexOf(QUERY, at + QUERY.length)) count += 1
  const joined = bytes.length >= QUERY.length - 1 ? bytes : Buffer.concat([tail, bytes])
  return { count, tail: Uint8Array.from(joined.subarray(Math.max(0, joined.length - (QUERY.length - 1)))) }
}

/** The protocol's states in the standard status. `clear` means the program has none any more. */
const STATES = new Map<string, AgentReport | 'clear'>([
  ['idle', { state: 'idle', reason: 'ready' }],
  ['working', { state: 'working', reason: 'turn' }],
  ['done', { state: 'idle', reason: 'finished' }],
  ['error', { state: 'idle', reason: 'error' }],
  ['clear', 'clear'],
])

/** What `blocked` waits for. A kind the program didn't give, or an unknown one, is a question. */
const BLOCKED = new Map<string, AgentReport>([
  ['permission', { state: 'waiting', reason: 'permission' }],
  ['auth', { state: 'waiting', reason: 'auth' }],
])
const BLOCKED_OTHER: AgentReport = { state: 'waiting', reason: 'question' }

/**
 * The `key=value` fields of a report, which the protocol separates with `:`,
 * with spaces around keys and values trimmed, so `state = working` reads as
 * `working` and ` id=sub` is still a child's record.
 */
function fields(data: string) {
  return new Map(
    data.split(':').map((field) => {
      const at = field.indexOf('=')
      return at === -1 ? [field.trim(), ''] : [field.slice(0, at).trim(), field.slice(at + 1).trim()]
    }),
  )
}

/**
 * One OSC 7501 sequence's data: `query` for the support question, the report
 * in the standard status, `clear`, or null for what isn't understood, which
 * leaves the status as it was. Only the root record counts: a report with an
 * `id` is a child's, such as a sub-agent's. The tables are `Map`s, so text from
 * the output such as `toString` never reaches an inherited property, and no
 * text from the report is kept.
 */
export function readProgramStatus(data: string): AgentReport | 'clear' | 'query' | null {
  const body = data.trim()
  if (body === '?' || body.startsWith('?:')) return 'query'
  const values = fields(data)
  if (values.get('id')) return null
  const state = values.get('state') ?? ''
  if (state === 'blocked') return BLOCKED.get(values.get('kind') ?? '') ?? BLOCKED_OTHER
  return STATES.get(state) ?? null
}
