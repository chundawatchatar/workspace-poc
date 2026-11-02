import { expect, test } from 'bun:test'
import { makePane, makeSurface, makeWorkspace, type SessionInfo } from '@orch/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentCounts } from '../lib/agentStatus'
import { AgentCounts } from './AgentCounts'

const render = (waiting: number, working: number, idle: number, active = false) =>
  renderToStaticMarkup(<AgentCounts counts={{ waiting, working, idle }} active={active} />)

test('renders nothing for a workspace with no agents to state', () => {
  const noTerminals = makeWorkspace('ws', '/w', makePane([makeSurface('pulls')]))
  const shell = makeSurface()
  const signalsIdle = makeSurface()
  const onlyShells = makeWorkspace('ws', '/w', makePane([shell]))
  const onlySignalsIdle = makeWorkspace('ws', '/w', makePane([signalsIdle]))
  const sessions = {
    [shell.id]: { agentState: null, progress: null },
    [signalsIdle.id]: {
      agentState: { state: 'idle', reason: 'detected', source: 'signals', since: 1 },
      progress: null,
    },
  } as unknown as Record<string, SessionInfo>

  for (const workspace of [noTerminals, onlyShells, onlySignalsIdle]) {
    const counts = agentCounts(workspace, sessions)
    expect(renderToStaticMarkup(<AgentCounts counts={counts} active={false} />)).toBe('')
  }
})

test('draws the non-zero states in the order waiting, working, idle, without a spinner', () => {
  const html = render(1, 2, 3)
  const shapes = ['lucide-hand', 'lucide-loader-circle', 'lucide-pause'].map((shape) => html.indexOf(shape))
  expect(shapes[0]).toBeGreaterThan(-1)
  expect(shapes).toEqual(shapes.toSorted((a, b) => a - b))
  expect(html).not.toContain('animate-spin')

  const idleOnly = render(0, 0, 3)
  expect(idleOnly).toContain('lucide-pause')
  expect(idleOnly).not.toContain('lucide-hand')
  expect(idleOnly).not.toContain('lucide-loader-circle')
})

test('gives the words to screen readers and the tooltip, and hides the drawing', () => {
  const html = render(1, 2, 0)
  expect(html).toContain('<span class="sr-only">2 agents working, 1 waiting</span>')
  expect(html).toContain('<span aria-hidden="true" title="2 agents working, 1 waiting"')
  expect(html.indexOf('sr-only')).toBeLessThan(html.indexOf('aria-hidden'))
  expect(html.slice(html.indexOf('aria-hidden'))).not.toContain('sr-only')
})

test('colours waiting with the accent and the others muted, on on-accent tokens when selected', () => {
  expect(render(1, 1, 0)).toContain('text-accent')
  expect(render(1, 1, 0)).toContain('text-dim')
  expect(render(1, 1, 0)).not.toContain('on-accent')

  const active = render(1, 1, 0, true)
  expect(active).toContain('text-on-accent"')
  expect(active).toContain('text-on-accent/70')
  expect(active).not.toContain('text-dim')
  expect(active).not.toContain('text-accent')
})
