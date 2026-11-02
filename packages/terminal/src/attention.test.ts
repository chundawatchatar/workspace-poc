import { describe, expect, test } from 'bun:test'
import { ATTENTION_MERGE_MS, AttentionSlot } from './attention'

describe('attention', () => {
  test('agent attention takes over an unseen signal from just before, keeping its time and origin', () => {
    const slot = new AttentionSlot()
    expect(slot.signal('Bell', 1000)).toBe(true)
    slot.agent('Claude Code finished', 1000 + ATTENTION_MERGE_MS - 1)
    expect(slot.current).toEqual({ at: 1000, message: 'Claude Code finished' })
  })

  test('a signal just after agent attention is dropped, even once it was seen', () => {
    const slot = new AttentionSlot()
    slot.agent('Claude Code needs permission', 5000)
    expect(slot.current).toEqual({ at: 5000, message: 'Claude Code needs permission', from: 'agent' })
    expect(slot.signal('Bell', 5001)).toBe(false)
    expect(slot.clear()).toBe(true)
    expect(slot.signal('Notification', 5000 + ATTENTION_MERGE_MS - 1)).toBe(false)
    expect(slot.current).toBeNull()
    expect(slot.clear()).toBe(false)
  })

  test('outside the window each replaces the other as before', () => {
    const slot = new AttentionSlot()
    slot.signal('Bell', 1000)
    slot.agent('Codex finished', 1000 + ATTENTION_MERGE_MS)
    expect(slot.current).toEqual({ at: 1000 + ATTENTION_MERGE_MS, message: 'Codex finished', from: 'agent' })
    expect(slot.signal('Bell', 1000 + 2 * ATTENTION_MERGE_MS)).toBe(true)
    expect(slot.current).toEqual({ at: 1000 + 2 * ATTENTION_MERGE_MS, message: 'Bell' })
  })
})
