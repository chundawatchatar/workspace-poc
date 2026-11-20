import { expect, test } from 'bun:test'
import { readProgramStatus, statusQueries } from './program-status'

test('every agent’s OSC 7501 reads into the standard status, and anything else leaves it alone', () => {
  const cases: [string, ReturnType<typeof readProgramStatus>][] = [
    ['?', 'query'],
    ['state=idle:app=claude-code', { state: 'idle', reason: 'ready' }],
    ['state=working:app=codex', { state: 'working', reason: 'turn' }],
    ['state=done:app=pi:msg=c2Vzc2lvbg==', { state: 'idle', reason: 'finished' }],
    ['state=error:app=pi:msg=Qm9vbQ==', { state: 'idle', reason: 'error' }],
    ['state=blocked:app=codex:kind=permission', { state: 'waiting', reason: 'permission' }],
    ['state=blocked:kind=auth', { state: 'waiting', reason: 'auth' }],
    ['state=blocked:kind=question', { state: 'waiting', reason: 'question' }],
    ['state=blocked', { state: 'waiting', reason: 'question' }],
    ['state=clear', 'clear'],
    // A child record, such as a sub-agent's, isn't the terminal's own status.
    ['state=working:id=sub', null],
    ['state=sleeping', null],
    // Text from the output never reaches an inherited property.
    ['state=toString', null],
    ['state=__proto__', null],
    ['state=blocked:kind=constructor', { state: 'waiting', reason: 'question' }],
    // Spaces around keys and values are trimmed, so a child record padded with one is still a child's.
    ['state = working', { state: 'working', reason: 'turn' }],
    [' state=blocked : kind = permission ', { state: 'waiting', reason: 'permission' }],
    ['state=working: id=sub', null],
    [' ? ', 'query'],
    ['', null],
  ]
  for (const [data, read] of cases) expect(readProgramStatus(data)).toEqual(read)
})

test('every support question in the raw output counts once, also one split across two pieces', () => {
  const bytes = (text: string) => new TextEncoder().encode(text)
  const query = '\x1b]7501;?\x1b\\'
  expect(statusQueries(new Uint8Array(), bytes(`a${query}b${query}`)).count).toBe(2)
  for (let split = 1; split < query.length; split++) {
    const first = statusQueries(new Uint8Array(), bytes(`text${query.slice(0, split)}`))
    const second = statusQueries(first.tail, bytes(`${query.slice(split)}more`))
    expect(first.count + second.count).toBe(1)
  }
  // Pieces shorter than the question still join up.
  let tail: Uint8Array = new Uint8Array()
  let count = 0
  for (const char of query) {
    const step = statusQueries(tail, bytes(char))
    count += step.count
    tail = step.tail
  }
  expect(count).toBe(1)
  expect(statusQueries(new Uint8Array(), bytes('\x1b]7501;state=working\x07')).count).toBe(0)
})
