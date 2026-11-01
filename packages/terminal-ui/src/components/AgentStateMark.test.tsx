import { expect, test } from 'bun:test'
import type { AgentStateName, SessionInfo } from '@orch/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { type AgentStatus, agentStatus } from '../lib/agentStatus'
import { AgentStateMark } from './AgentStateMark'

const agent = { kind: 'claude', sessionId: null, cwd: '/w' } as const

function status(state: AgentStateName, progress: SessionInfo['progress'] = null) {
  const agentState = { state, reason: 'tool', source: 'hooks', since: 1 } as const
  return agentStatus({ agentState, progress, agent }) as AgentStatus
}

test('each kind has its own shape, role and accessible name', () => {
  const marks = [status('working'), status('waiting'), status('idle'), status('idle', 'error')].map((s) => {
    const html = renderToStaticMarkup(<AgentStateMark status={s} size={10} />)
    expect(html).toContain('role="img"')
    expect(html).toContain(`aria-label="${s.label}"`)
    expect(html).not.toContain('aria-hidden')
    return html
  })

  expect(marks[0]).toContain('lucide-loader-circle')
  expect(marks[0]).toContain('animate-spin')
  expect(marks[1]).toContain('lucide-hand')
  expect(marks[1]).toContain('text-warn')
  expect(marks[2]).toContain('lucide-moon')
  expect(marks[2]).toContain('text-faint')
  expect(marks[3]).toContain('lucide-circle-alert')
  expect(marks[3]).toContain('text-bad')
})

test('a mark on the selected tile drops its status colour for the on-accent one', () => {
  const html = renderToStaticMarkup(<AgentStateMark status={status('waiting')} size={10} onAccent />)
  expect(html).toContain('text-on-accent')
  expect(html).not.toContain('text-warn')
})
