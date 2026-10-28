import { flushSync } from 'react-dom'

// Layout changes (split, close, move a tab, full screen) jump from one
// arrangement to another. The browser's view transitions animate between the
// two: each pane glides to its new place, and panes that appear or go fade.

let running = 0

/** Panes only carry a transition name while one is running, so they stack normally the rest of the time. */
function namePanes(on: boolean, raisedPaneId?: string) {
  for (const pane of document.querySelectorAll<HTMLElement>('[data-pane-id]')) {
    pane.style.viewTransitionName = on ? `pane-${pane.dataset.paneId}` : ''
    // The raised pane is drawn above the others while it moves (see styles.css).
    if (on && pane.dataset.paneId === raisedPaneId) pane.dataset.raised = 'true'
    else if (!on) delete pane.dataset.raised
  }
}

/**
 * Runs a layout change, animated where the browser supports it and the user
 * has not asked for less motion. `raisedPaneId` names a pane that should stay
 * on top during the animation, such as one entering or leaving full screen.
 */
export function withPaneTransition(update: () => void, raisedPaneId?: string) {
  if (
    typeof document.startViewTransition !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    update()
    return
  }
  running++
  namePanes(true, raisedPaneId)
  const transition = document.startViewTransition(() => {
    flushSync(update)
    namePanes(true, raisedPaneId)
  })
  transition.finished
    .catch(() => {})
    .finally(() => {
      if (--running === 0) namePanes(false)
    })
}
