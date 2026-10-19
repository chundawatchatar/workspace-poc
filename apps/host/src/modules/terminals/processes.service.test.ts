import { describe, expect, test } from 'bun:test'
import { findForeground, parseElapsed, parsePs } from './processes.service'

// Shell 100 runs claude (200). Shell 300 is idle. Shell 400 runs `cat log | less`, whose `cat` (500) has exited.
const PS = `
  100   100   200    01:02:03 -zsh
  200   200   200       00:05 node /usr/local/bin/claude --resume
  300   300   300  2-00:00:10 /bin/zsh -l
  400   400   500       00:09 -zsh
  501   500   500       00:08 less
  600   600    -1       00:01 /usr/sbin/cfprefsd agent
`

describe('findForeground', () => {
  test('reports the program leading the foreground group, under the name it gives itself', () => {
    const found = findForeground(parsePs(PS), [100])
    expect(found.get(100)).toEqual({
      process: { pid: 200, name: 'node', command: 'node /usr/local/bin/claude --resume', elapsed: 5 },
      busy: true,
    })
  })

  test('a pipeline stays busy after its first command exits, showing a stage that still runs', () => {
    const found = findForeground(parsePs(PS), [400])
    expect(found.get(400)?.busy).toBe(true)
    expect(found.get(400)?.process.name).toBe('less')
  })

  test('a shell in its own foreground is idle, and an unknown pid is left out', () => {
    const found = findForeground(parsePs(PS), [300, 999])
    expect(found.get(300)?.busy).toBe(false)
    expect(found.get(300)?.process.name).toBe('zsh')
    expect(found.has(999)).toBe(false)
  })
})

test('parseElapsed reads every ps elapsed-time format', () => {
  expect(parseElapsed('00:05')).toBe(5)
  expect(parseElapsed('01:02:03')).toBe(3723)
  expect(parseElapsed('2-00:00:10')).toBe(172_810)
})
