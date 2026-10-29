import { Bot, ChevronRight, GitBranch, RotateCcw, Server, SquareTerminal, TestTube2 } from '@orch/ui/icons'
import { type ReactNode, useEffect, useState } from 'react'
import { type DemoState, DURATION, focusPane, type Line, type PaneId, stateAt, type Tone } from '../lib/demo-script'

const TONE: Record<Tone, string> = {
  ink: 'text-ink',
  dim: 'text-dim',
  faint: 'text-faint',
  accent: 'text-accent',
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
}

const WORKSPACES = [
  { id: 'api-server', branch: 'feat/rate-limit', changes: 3 },
  { id: 'web', branch: 'main', changes: 0 },
  { id: 'docs', branch: 'main', changes: 1 },
]

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** Milliseconds since the demo started, ticking until the script has run. */
function useClock(runId: number) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    void runId
    if (reducedMotion()) {
      setElapsed(DURATION)
      return
    }
    const start = performance.now()
    let frame = 0
    const tick = () => {
      const now = performance.now() - start
      setElapsed(now)
      if (now <= DURATION) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [runId])
  return elapsed
}

/**
 * A scripted Orchestrator window. An agent finishes in a pane you aren't watching, so the pane gets the attention
 * ring, its tab a dot and the workspace a count. Clicking the pane clears them, as in the app.
 */
export function HeroDemo() {
  const [runId, setRunId] = useState(0)
  const [seen, setSeen] = useState<PaneId[]>([])
  const [focus, setFocus] = useState<PaneId | null>(null)
  const [openedWeb, setOpenedWeb] = useState(false)
  const elapsed = useClock(runId)

  let state: DemoState = stateAt(elapsed)
  for (const pane of seen) state = focusPane(state, pane)
  if (focus) state = { ...state, focus }
  if (openedWeb) state = { ...state, pending: { ...state.pending, web: undefined } }

  const waiting = Object.values(state.pending).reduce((sum, entry) => sum + (entry?.count ?? 0), 0)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('orch:demo-attention', { detail: waiting }))
  }, [waiting])

  const look = (pane: PaneId) => {
    setFocus(pane)
    setSeen((list) => (list.includes(pane) ? list : [...list, pane]))
  }

  const replay = () => {
    setSeen([])
    setFocus(null)
    setOpenedWeb(false)
    setRunId((id) => id + 1)
  }

  const pane = (id: PaneId, tabs: { title: string; icon: ReactNode }[], rows: number, className = '') => (
    <Pane
      lines={state.lines[id]}
      typing={state.typing[id]}
      tabs={tabs}
      rows={rows}
      focused={state.focus === id}
      attention={state.attention.includes(id)}
      onFocus={() => look(id)}
      className={className}
    />
  )

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-lg shadow-black/5">
      <div className="flex h-9 items-center gap-3 border-b border-line bg-sidebar px-3">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-bad/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-warn/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-good/70" />
        </span>
        <span className="min-w-0 flex-1 truncate rounded bg-bg/60 px-2 py-0.5 text-center font-mono text-[11px] text-faint">
          127.0.0.1:3210/w/api-server
        </span>
        <button
          type="button"
          onClick={replay}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-dim hover:bg-raised hover:text-ink"
          aria-label="Replay the demo"
        >
          <RotateCcw size={12} />
          <span className="hidden sm:inline">Replay</span>
        </button>
      </div>

      <div className="grid md:grid-cols-[176px_1fr]">
        <aside className="hidden flex-col border-r border-line bg-sidebar md:flex" aria-label="Demo workspaces">
          <div className="flex h-9 items-center px-3 text-[10px] font-semibold tracking-wider text-faint uppercase">
            Workspaces
          </div>
          <div className="space-y-1 px-2 pb-2">
            {WORKSPACES.map((workspace, index) => {
              const active = workspace.id === 'api-server'
              const pending = state.pending[workspace.id]
              return (
                <button
                  type="button"
                  key={workspace.id}
                  onClick={() => workspace.id === 'web' && setOpenedWeb(true)}
                  className={`block w-full rounded-md px-2.5 py-1.5 text-left ${
                    active ? 'bg-accent text-on-accent' : 'text-ink hover:bg-raised'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <ChevronRight size={11} className="-ml-1 rotate-90 opacity-70" />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{workspace.id}</span>
                    {pending ? (
                      <span
                        className={`anim-pop flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold ${
                          active ? 'bg-on-accent text-accent' : 'bg-accent text-on-accent'
                        }`}
                      >
                        {pending.count}
                      </span>
                    ) : (
                      <span className={`text-[10px] ${active ? 'text-on-accent/60' : 'text-faint'}`}>⌃{index + 1}</span>
                    )}
                  </span>
                  <span
                    className={`mt-0.5 flex items-center gap-1 text-[10px] ${active ? 'text-on-accent/75' : 'text-dim'}`}
                  >
                    <GitBranch size={10} />
                    <span className="truncate">{workspace.branch}</span>
                    {workspace.changes > 0 && <span className="ml-auto">+{workspace.changes}</span>}
                  </span>
                  {pending && (
                    <span
                      className={`anim-fade mt-1 block truncate text-[10px] ${active ? 'text-on-accent/85' : 'text-accent'}`}
                    >
                      {pending.message}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </aside>

        <div className="grid h-[380px] grid-rows-[1fr_150px] sm:h-[420px] md:grid-cols-[1.15fr_1fr] md:grid-rows-none">
          {pane(
            'agent',
            [
              { title: 'claude', icon: <Bot size={12} /> },
              { title: 'zsh', icon: <SquareTerminal size={12} /> },
            ],
            15,
            'md:border-r md:border-line',
          )}
          <div className="grid min-h-0 border-t border-line md:grid-rows-2 md:border-t-0">
            {pane('dev', [{ title: 'bun run dev', icon: <Server size={12} /> }], 7)}
            {pane(
              'test',
              [{ title: 'bun test', icon: <TestTube2 size={12} /> }],
              6,
              'hidden border-t border-line md:flex',
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Pane(props: {
  lines: Line[]
  typing: string
  tabs: { title: string; icon: ReactNode }[]
  rows: number
  focused: boolean
  attention: boolean
  onFocus: () => void
  className?: string
}) {
  const { lines, typing, tabs, rows, focused, attention } = props
  const visible = lines.slice(-(typing ? rows - 1 : rows))
  return (
    <section
      aria-label={`${tabs[0]?.title} pane`}
      onClick={props.onFocus}
      className={`relative flex min-h-0 min-w-0 cursor-pointer flex-col bg-panel ${props.className ?? ''}`}
    >
      <div className="flex h-8 shrink-0 items-stretch border-b border-line bg-sidebar">
        {tabs.map((tab, i) => (
          <span
            key={tab.title}
            className={`flex max-w-40 min-w-20 items-center gap-1.5 border-r border-line px-2.5 text-[11px] ${
              i === 0 ? `bg-panel ${focused ? 'text-ink' : 'text-dim'}` : 'text-faint'
            }`}
          >
            <span className={i === 0 && focused ? 'text-accent' : ''}>{tab.icon}</span>
            <span className="min-w-0 flex-1 truncate">{tab.title}</span>
            {i === 0 && attention && <span className="anim-pop h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
          </span>
        ))}
      </div>
      <div
        className={`min-h-0 flex-1 overflow-hidden px-3 py-2 font-mono text-[11.5px] leading-[1.6] transition-opacity sm:text-[12px] ${
          focused ? '' : 'opacity-70'
        }`}
      >
        {visible.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are append-only, so the index is stable
          <TerminalLine key={lines.length - visible.length + i} line={line} />
        ))}
        {/* A prompt only while typing or before the first command: a running program owns the rest of the pane. */}
        {(typing || lines.length === 0) && (
          <div className="whitespace-pre">
            <Prompt />
            {typing}
            <span className="caret" />
          </div>
        )}
      </div>
      {attention && <div className="attention-ring pointer-events-none absolute inset-0 z-10" />}
    </section>
  )
}

function Prompt() {
  return <span className="text-good">❯ </span>
}

function TerminalLine({ line }: { line: Line }) {
  return (
    <div className={`truncate whitespace-pre ${TONE[line.tone ?? 'ink']}`}>
      {line.prompt && <Prompt />}
      {line.text}
    </div>
  )
}
