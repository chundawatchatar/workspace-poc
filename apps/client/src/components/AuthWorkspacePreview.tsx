import { Check, LoaderCircle } from '@orch/ui/icons'
import { type ReactNode, useEffect, useState } from 'react'

// A scripted picture of the app beside the auth card, drawn with the app's own surfaces: the sidebar, split panes with
// their tab bars, and the attention ring, which moves to whichever agent is waiting. Nothing here is live or
// focusable, and with reduced motion it holds the first scene.

type Status = 'busy' | 'waiting' | 'done' | 'idle'
type Line = { text: string; tone?: 'ink' | 'good' | 'faint' | 'prompt' }
type PaneScene = { status: Status; lines: Line[] }

const PANES = ['claude · checkout', 'codex · search', 'bun test'] as const

/** Each scene sets every pane; the preview steps through them in a loop. */
const SCENES: { panes: [PaneScene, PaneScene, PaneScene]; note: string | null }[] = [
  {
    panes: [
      {
        status: 'waiting',
        lines: [
          { text: 'Edited Cart.tsx', tone: 'ink' },
          { text: '2 tests expect the old total' },
          { text: 'Update the snapshots?', tone: 'prompt' },
        ],
      },
      { status: 'busy', lines: [{ text: 'Reading 14 files…' }, { text: 'Planning the index change' }] },
      {
        status: 'done',
        lines: [
          { text: '✓ 128 pass', tone: 'good' },
          { text: '0 fail · 1.84s', tone: 'faint' },
        ],
      },
    ],
    note: 'claude · checkout is asking a question',
  },
  {
    panes: [
      { status: 'busy', lines: [{ text: 'Updating 2 snapshots…' }] },
      {
        status: 'waiting',
        lines: [
          { text: 'New index is ready', tone: 'ink' },
          { text: 'The old one is still used by search.ts' },
          { text: 'Remove the old index?', tone: 'prompt' },
        ],
      },
      { status: 'busy', lines: [{ text: 'Running 130 tests…' }] },
    ],
    note: 'codex · search is asking a question',
  },
  {
    panes: [
      {
        status: 'done',
        lines: [
          { text: '✓ Snapshots updated', tone: 'good' },
          { text: '2 files changed', tone: 'faint' },
        ],
      },
      { status: 'busy', lines: [{ text: 'Removing the old index…' }, { text: 'Updating search.ts' }] },
      {
        status: 'done',
        lines: [
          { text: '✓ 130 pass', tone: 'good' },
          { text: '0 fail · 1.92s', tone: 'faint' },
        ],
      },
    ],
    note: null,
  },
]

const SCENE_MS = 3600

const toneClass = { ink: 'text-ink', good: 'text-good', faint: 'text-faint', prompt: 'mt-1 text-ink' } as const

function StatusIcon({ status }: { status: Status }) {
  if (status === 'busy') return <LoaderCircle className="size-3 animate-spin" />
  if (status === 'done') return <Check className="size-3 text-good" />
  if (status === 'waiting') return <span className="size-1.5 rounded-full bg-accent" />
  return null
}

function Pane(props: { tab: string; status: Status; children: ReactNode }) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-col bg-panel">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-sidebar px-2.5 text-[11px]">
        <span className="truncate text-ink">{props.tab}</span>
        <span className="ml-auto flex shrink-0 items-center text-dim">
          <StatusIcon status={props.status} />
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-dim">
        {props.children}
      </div>
      {/* Over the pane, as the app draws it, so the tab bar does not hide its top edge. */}
      {props.status === 'waiting' && <div className="attention-ring pointer-events-none absolute inset-0 z-10" />}
    </div>
  )
}

/** The lines of one pane in one scene, appearing one after another. */
function Lines({ lines, waiting }: { lines: Line[]; waiting: boolean }) {
  return lines.map((line, index) => (
    <p
      key={line.text}
      className={`anim-fade ${line.tone ? toneClass[line.tone] : ''}`}
      style={{ animationDelay: `${index * 140}ms`, animationFillMode: 'backwards' }}
    >
      {line.text}
      {waiting && index === lines.length - 1 && (
        <span className="mt-0.5 block">
          <span className="text-accent">›</span> yes / no
          <span className="ml-0.5 inline-block h-2.5 w-1.5 animate-pulse bg-accent align-middle" />
        </span>
      )}
    </p>
  ))
}

function Workspace(props: { name: string; terminals: number; waiting?: number; active?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${props.active ? 'bg-accent text-on-accent' : 'text-ink'}`}
    >
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{props.name}</span>
      {props.waiting ? (
        <span className="anim-pop flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-on-accent px-1 text-[9px] font-semibold text-accent">
          {props.waiting}
        </span>
      ) : null}
      <span className={`text-[9px] ${props.active ? 'text-on-accent/60' : 'text-faint'}`}>{props.terminals}</span>
    </div>
  )
}

/** How many times the scenes play before the preview settles on the first one, so it does not move forever. */
const LOOPS = 3

/**
 * Steps through `SCENES` while `playing`, and stops on the first scene after `LOOPS` rounds. It never starts with
 * reduced motion, and waits while the tab is hidden.
 */
function useScene(playing: boolean) {
  const [step, setStep] = useState(0)
  const [still, setStill] = useState(true)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setStill(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const finished = step >= LOOPS * SCENES.length
  useEffect(() => {
    if (still || finished || !playing) return
    const timer = window.setInterval(() => {
      if (!document.hidden) setStep((current) => current + 1)
    }, SCENE_MS)
    return () => window.clearInterval(timer)
  }, [still, finished, playing])
  return SCENES[still || finished ? 0 : step % SCENES.length]
}

/** The app with three agents at work in one workspace, taking turns to need you. */
export function AuthWorkspacePreview() {
  // Pointing at the preview holds the current scene, so it can be read.
  const [hovered, setHovered] = useState(false)
  const { panes, note } = useScene(!hovered)
  const waiting = panes.filter((pane) => pane.status === 'waiting').length

  return (
    <div
      aria-hidden="true"
      className="flex flex-col gap-3 select-none"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="grid h-[260px] grid-cols-[112px_1fr] overflow-hidden rounded-lg border border-line bg-bg shadow-md shadow-black/5">
        <div className="flex min-h-0 flex-col border-r border-line bg-sidebar">
          <div className="flex h-8 items-center px-2.5 text-[9px] font-semibold tracking-wider text-faint uppercase">
            studio-mac
          </div>
          <div className="flex flex-col gap-0.5 px-1.5">
            <Workspace name="website" terminals={4} waiting={waiting} active />
            <Workspace name="api" terminals={2} />
            <Workspace name="infra" terminals={1} />
          </div>
          <div className="mt-auto flex h-7 items-center gap-1.5 border-t border-line px-2.5 text-[10px] text-dim">
            <span className="size-1.5 rounded-full bg-good" />
            Connected
          </div>
        </div>
        <div className="grid min-h-0 grid-cols-2 grid-rows-[1.15fr_1fr] gap-px bg-line">
          {panes.map((pane, index) => (
            <Pane key={PANES[index]} tab={PANES[index]} status={pane.status}>
              <Lines lines={pane.lines} waiting={pane.status === 'waiting'} />
            </Pane>
          ))}
          <Pane tab="zsh" status="idle">
            <p>
              <span className="text-good">~/website</span> <span className="text-faint">main</span>
            </p>
            <p>
              <span className="text-accent">$</span> git status
            </p>
            <p>nothing to commit</p>
          </Pane>
        </div>
      </div>
      <p key={note ?? 'none'} className="anim-fade flex items-center gap-2 font-mono text-[11px] text-dim">
        <span className={`size-1.5 rounded-full ${note ? 'bg-accent' : 'bg-good'}`} />
        {note ?? 'Nothing needs you. Agents are working.'}
      </p>
    </div>
  )
}
