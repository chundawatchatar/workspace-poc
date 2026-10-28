/** How long a toast stays on screen, in milliseconds. */
export const TOAST_DURATION = 2000

export type ToastKind = 'info' | 'error'

export interface Toast {
  /** Changes with every toast, so a replacement plays its entrance again. */
  id: number
  message: string
  kind: ToastKind
}

/** The timer a toaster schedules with. Tests pass a fake one. */
export interface ToastTimer {
  set: (callback: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimer: ToastTimer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Creates a toast queue holding at most one toast. Showing a new one replaces
 * the current one and restarts the countdown, so the old timer never hides it.
 */
export function createToaster(timer: ToastTimer = realTimer) {
  let current: Toast | null = null
  let handle: unknown = null
  let nextId = 1
  const listeners = new Set<() => void>()

  function set(toast: Toast | null) {
    current = toast
    for (const listener of listeners) listener()
  }

  return {
    show(message: string, kind: ToastKind = 'info') {
      if (handle !== null) timer.clear(handle)
      const toast = { id: nextId++, message, kind }
      handle = timer.set(() => {
        handle = null
        if (current === toast) set(null)
      }, TOAST_DURATION)
      set(toast)
    },
    /** The toast on screen; null means none. */
    get: (): Toast | null => current,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const toaster = createToaster()

/** Shows a short message at the bottom of the window, replacing any toast already there. */
export const showToast = toaster.show
export const getToast = toaster.get
export const subscribeToast = toaster.subscribe
