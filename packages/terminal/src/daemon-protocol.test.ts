import { expect, test } from 'bun:test'
import { DaemonDecoder, encodeControlFrame, encodeOutputFrame } from './daemon-protocol'

test('decodes fragmented and coalesced frames, keeping control and output apart', () => {
  const decoder = new DaemonDecoder()
  const control = encodeControlFrame({ type: 'input', data: '中文 😀' })
  const output = encodeOutputFrame(new Uint8Array([0, 1, 2, 255]))
  expect(decoder.push(control.subarray(0, 3))).toEqual([])
  expect(decoder.push(control.subarray(3, control.length - 1))).toEqual([])
  const frames = decoder.push(Buffer.concat([control.subarray(-1), output]))
  expect(frames[0]).toEqual({ kind: 'control', value: { type: 'input', data: '中文 😀' } })
  expect(frames[1]?.kind).toBe('output')
  if (frames[1]?.kind === 'output') expect(Buffer.from(frames[1].bytes)).toEqual(Buffer.from([0, 1, 2, 255]))
})

test('rejects unbounded or empty daemon frames before buffering their payload', () => {
  for (const length of [0, 16 * 1024 * 1024 + 1, 0xffffffff]) {
    const header = Buffer.alloc(5)
    header.writeUInt8(1, 0)
    header.writeUInt32BE(length, 1)
    expect(() => new DaemonDecoder().push(header)).toThrow('Invalid terminal daemon frame length')
  }
})
