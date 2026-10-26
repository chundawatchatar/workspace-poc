import { describe, expect, test } from 'bun:test'
import { createToaster, TOAST_DURATION, type ToastTimer } from './toast'

// A clock that only moves when the test advances it.
function fakeTimer() {
  let now = 0
  let nextHandle = 1
  const pending = new Map<number, { at: number; callback: () => void }>()
  const timer: ToastTimer = {
    set: (callback, ms) => {
      const handle = nextHandle++
      pending.set(handle, { at: now + ms, callback })
      return handle
    },
    clear: (handle) => pending.delete(handle as number),
  }
  const advance = (ms: number) => {
    now += ms
    for (const [handle, entry] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (entry.at > now) continue
      pending.delete(handle)
      entry.callback()
    }
  }
  return { timer, advance }
}

describe('toaster', () => {
  test('a toast stays until its duration has passed, then hides itself and tells subscribers', () => {
    const { timer, advance } = fakeTimer()
    const toaster = createToaster(timer)
    let notified = 0
    toaster.subscribe(() => notified++)

    toaster.show('Copied ~/src')
    expect(toaster.get()).toMatchObject({ message: 'Copied ~/src', kind: 'info' })
    advance(TOAST_DURATION - 1)
    expect(toaster.get()?.message).toBe('Copied ~/src')
    advance(1)
    expect(toaster.get()).toBeNull()
    expect(notified).toBe(2)
  })

  test('a new toast replaces the current one and restarts the countdown', () => {
    const { timer, advance } = fakeTimer()
    const toaster = createToaster(timer)

    toaster.show('First')
    advance(1500)
    toaster.show('Could not copy folder', 'error')
    const second = toaster.get()
    expect(second).toMatchObject({ message: 'Could not copy folder', kind: 'error' })

    // The first toast's deadline passes without hiding the second.
    advance(500)
    expect(toaster.get()).toBe(second)
    advance(TOAST_DURATION - 500)
    expect(toaster.get()).toBeNull()
  })
})
