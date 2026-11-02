export type ToastKind = 'info' | 'error'

/**
 * Where a toast shows. `bottom` (centred) is the default; `top-right` is for an action started from a control up
 * there, such as signing out from the account menu, so the message appears where the user is already looking.
 */
export type ToastPlacement = 'bottom' | 'top-right'

export interface ToastOptions {
  placement?: ToastPlacement
}

/** How long a toast stays on screen, in milliseconds. An error stays longer, since it usually asks for a retry. */
export const TOAST_DURATION: Record<ToastKind, number> = { info: 2000, error: 6000 }

export interface Toast {
  /** Changes with every toast, so a replacement plays its entrance again. */
  id: number
  message: string
  kind: ToastKind
  placement: ToastPlacement
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
    show(message: string, kind: ToastKind = 'info', options: ToastOptions = {}) {
      if (handle !== null) timer.clear(handle)
      const toast = { id: nextId++, message, kind, placement: options.placement ?? 'bottom' }
      handle = timer.set(() => {
        handle = null
        if (current === toast) set(null)
      }, TOAST_DURATION[kind])
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

/**
 * Shows a short message at the bottom of the window, replacing any toast already there. Use it for the outcome of an
 * action, such as a copy or a failed sign-out; a problem with a form's input goes in the form, with `FormError`.
 * Needs a `<Toaster />` mounted once at the app's root.
 */
export const showToast = toaster.show
export const getToast = toaster.get
export const subscribeToast = toaster.subscribe
