// The hero's scripted session: an agent finishes in one pane while you watch another, and Orchestrator flags it.

export type PaneId = 'agent' | 'dev' | 'test'
export type Tone = 'ink' | 'dim' | 'faint' | 'accent' | 'good' | 'warn' | 'bad'

export interface Line {
  text: string
  tone?: Tone
  prompt?: boolean
}

export interface DemoState {
  lines: Record<PaneId, Line[]>
  /** The command being typed at each pane's prompt. */
  typing: Record<PaneId, string>
  focus: PaneId
  /** Panes whose terminal rang while you looked elsewhere. */
  attention: PaneId[]
  /** Waiting notifications and their last message, per workspace in the sidebar. */
  pending: Record<string, { count: number; message: string } | undefined>
}

interface Step {
  at: number
  run: (state: DemoState) => void
}

const CHAR_MS = 32

export function initialState(): DemoState {
  return {
    lines: { agent: [], dev: [], test: [] },
    typing: { agent: '', dev: '', test: '' },
    focus: 'dev',
    attention: [],
    pending: {},
  }
}

function buildSteps(): Step[] {
  const steps: Step[] = []
  const at = (time: number, run: Step['run']) => steps.push({ at: time, run })
  const out = (time: number, pane: PaneId, text: string, tone?: Tone) =>
    at(time, (s) => {
      s.lines[pane].push({ text, tone })
    })
  /** Types a command at the prompt, then runs it. Returns when it was entered. */
  const type = (time: number, pane: PaneId, command: string) => {
    for (let i = 1; i <= command.length; i++) {
      at(time + i * CHAR_MS, (s) => {
        s.typing[pane] = command.slice(0, i)
      })
    }
    const entered = time + command.length * CHAR_MS + 220
    at(entered, (s) => {
      s.typing[pane] = ''
      s.lines[pane].push({ text: command, prompt: true })
    })
    return entered
  }

  // The dev server and test watcher you are looking at.
  const dev = type(150, 'dev', 'bun run dev')
  out(dev + 300, 'dev', 'ready in 312 ms', 'dim')
  out(dev + 360, 'dev', '➜  http://localhost:5173/', 'accent')
  const test = type(400, 'test', 'bun test --watch')
  out(test + 500, 'test', '18 pass · 0 fail', 'good')
  out(test + 560, 'test', 'watching for changes…', 'faint')

  // The agent, working in a pane you are not watching.
  const agent = type(300, 'agent', 'claude "rate-limit POST /login"')
  const work: [string, Tone?][] = [
    ['⏺ Read src/routes/auth.ts', 'ink'],
    ['⏺ Write src/middleware/rate-limit.ts', 'ink'],
    ['  ⎿ +42 lines', 'good'],
    ['⏺ Update src/routes/auth.ts', 'ink'],
    ['  ⎿ +3 −1', 'dim'],
    ['⏺ Bash bun test', 'ink'],
    ['  ⎿ 21 pass · 0 fail', 'good'],
  ]
  work.forEach(([text, tone], i) => {
    out(agent + 700 + i * 650, 'agent', text, tone)
  })
  const done = agent + 700 + work.length * 650 + 300
  out(done, 'agent', '✻ Done. 5 attempts per minute per IP.', 'accent')

  // Traffic on the dev server, and the watcher picking up the agent's edits.
  for (let i = 0; i < 3; i++) out(dev + 1400 + i * 900, 'dev', `POST /login 200 ${3 + i}ms`, 'dim')
  out(agent + 2100, 'test', 're-running · 3 files changed', 'faint')
  out(agent + 2700, 'test', '21 pass · 0 fail', 'good')
  out(done + 500, 'dev', 'POST /login 429 1ms', 'warn')

  // The agent rings the bell while you watch the dev server: ring, tab dot, sidebar count.
  at(done + 150, (s) => {
    s.attention.push('agent')
    s.pending['api-server'] = { count: 1, message: 'claude: Done. 5 attempts per minute…' }
  })
  // An agent in another workspace finishes too.
  at(done + 2200, (s) => {
    s.pending.web = { count: 1, message: 'codex: 12 tests written' }
  })
  return steps.sort((a, b) => a.at - b.at)
}

export const STEPS = buildSteps()

/** When the last step runs. */
export const DURATION = STEPS[STEPS.length - 1]?.at ?? 0

/** The state after every step up to `elapsed` ms has run. */
export function stateAt(elapsed: number): DemoState {
  const state = initialState()
  for (const step of STEPS) {
    if (step.at > elapsed) break
    step.run(state)
  }
  return state
}

/** Looking at a pane clears its notification, as in the app. */
export function focusPane(state: DemoState, pane: PaneId): DemoState {
  const attention = state.attention.filter((id) => id !== pane)
  const pending = { ...state.pending }
  if (pane === 'agent') pending['api-server'] = undefined
  return { ...state, focus: pane, attention, pending }
}
