import { expect, test } from 'bun:test'
import type { AgentReport } from '@orch/agents/runtime'
import { AgentReports, NOTIFY_REPEAT_MS, STATUS_INTERVAL_MS } from './agent-reports'

function setup() {
  const changes: string[] = []
  const notes: string[] = []
  const reports = new AgentReports(
    (id) => changes.push(id),
    (id, message) => notes.push(`${id}: ${message}`),
    () => 1000,
  )
  reports.setReporting('a', true)
  return { reports, changes, notes }
}

const r = (state: AgentReport['state'], reason: AgentReport['reason']): AgentReport => ({ state, reason })

test('a session keeps its last report, and only a change counts', () => {
  const { reports, changes } = setup()
  reports.report('a', r('working', 'turn'))
  reports.report('a', r('working', 'turn'))
  expect(reports.last('a')).toEqual({ state: 'working', reason: 'turn', at: 1000 })
  expect(changes).toEqual(['a'])
  reports.report('a', 'clear')
  expect(reports.last('a')).toBeNull()
  reports.report('b', r('working', 'turn'))
  expect(reports.last('b')).toBeNull()
})

test('needing the user and ending a turn notify once each, and nothing else does', () => {
  const { reports, notes } = setup()
  const steps: [AgentReport, string | null][] = [
    [r('idle', 'ready'), null],
    [r('working', 'turn'), null],
    [r('waiting', 'permission'), 'Needs permission'],
    [r('waiting', 'permission'), null],
    [r('working', 'turn'), null],
    [r('waiting', 'question'), 'Has a question'],
    [r('waiting', 'auth'), 'Needs you to sign in'],
    [r('idle', 'finished'), 'Finished'],
    [r('idle', 'ready'), null],
    [r('idle', 'finished'), null],
    [r('working', 'turn'), null],
    [r('idle', 'error'), 'Failed'],
  ]
  for (const [report, expected] of steps) {
    const before = notes.length
    reports.report('a', report)
    expect(notes.slice(before)).toEqual(expected ? [`a: ${expected}`] : [])
  }
})

test('with the switch off a report is kept but notifies nothing, and an ended agent leaves none', () => {
  const { reports, notes } = setup()
  reports.setReporting('a', false)
  reports.report('a', r('working', 'turn'))
  reports.report('a', r('waiting', 'permission'))
  expect(notes).toEqual([])
  expect(reports.last('a')?.state).toBe('waiting')
  reports.clear('a')
  expect(reports.last('a')).toBeNull()
})

test('a program changing its status in a loop sends it at most once per interval, and repeats no notification', async () => {
  const clock = { now: 1000 }
  const changes: string[] = []
  const notes: string[] = []
  const reports = new AgentReports(
    (id) => changes.push(`${id}:${reports.last(id)?.state}`),
    (id, message) => notes.push(`${id}: ${message}`),
    () => clock.now,
  )
  reports.setReporting('a', true)
  for (let i = 0; i < 50; i++) {
    clock.now += 1
    reports.report('a', r('working', 'turn'))
    reports.report('a', r('waiting', 'permission'))
  }
  reports.report('a', r('idle', 'finished'))
  // The first change went out at once; the rest wait for the interval and go out together, as the latest state.
  expect(changes).toEqual(['a:working'])
  expect(notes).toEqual(['a: Needs permission', 'a: Finished'])
  clock.now += STATUS_INTERVAL_MS
  await Bun.sleep(STATUS_INTERVAL_MS + 20)
  expect(changes).toEqual(['a:working', 'a:idle'])

  // Once the repeat window has passed, the same moment is raised again.
  clock.now += NOTIFY_REPEAT_MS
  reports.report('a', r('waiting', 'permission'))
  expect(notes.at(-1)).toBe('a: Needs permission')
  reports.close('a')
})
