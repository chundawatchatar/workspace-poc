import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { withPaneTransition } from './transition'

const original = Object.getOwnPropertyDescriptor(document, 'startViewTransition')
afterEach(() => {
  if (original) Object.defineProperty(document, 'startViewTransition', original)
  else Reflect.deleteProperty(document, 'startViewTransition')
  mock.restore()
  document.body.replaceChildren()
})

/** Waits a full task, so every promise callback queued by a finished transition has run. */
const settle = () => new Promise((resolve) => setTimeout(resolve))

describe('pane transitions', () => {
  test('updates immediately without view transitions or when reduced motion is requested', () => {
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: undefined })
    let updates = 0
    withPaneTransition(() => updates++)
    expect(updates).toBe(1)
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    Object.defineProperty(media, 'matches', { configurable: true, value: true })
    spyOn(window, 'matchMedia').mockReturnValue(media)
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: () => {
        throw new Error('Reduced motion must skip animation')
      },
    })
    withPaneTransition(() => updates++)
    expect(updates).toBe(2)
  })

  test('keeps pane names until every overlapping transition finishes, including a rejected animation', async () => {
    const pane = document.createElement('div')
    pane.dataset.paneId = 'p1'
    document.body.append(pane)
    const completions: ReturnType<typeof Promise.withResolvers<void>>[] = []
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: (update: () => void) => {
        update()
        const completion = Promise.withResolvers<void>()
        completions.push(completion)
        return { finished: completion.promise }
      },
    })
    let updates = 0
    withPaneTransition(() => updates++, 'p1')
    withPaneTransition(() => updates++)
    expect(updates).toBe(2)
    expect(pane.style.viewTransitionName).toBe('pane-p1')
    expect(pane.dataset.raised).toBe('true')
    completions[0].resolve()
    await settle()
    expect(pane.style.viewTransitionName).toBe('pane-p1')
    completions[1].reject(new Error('Animation cancelled'))
    await settle()
    expect(pane.style.viewTransitionName).toBe('')
    expect(pane.dataset.raised).toBeUndefined()
  })
})
