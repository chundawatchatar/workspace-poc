import { Check, CircleAlert } from './icons'
import type { ToastPlacement } from './lib/toast'

interface Props {
  message: string
  kind: 'info' | 'error'
  /** Defaults to `bottom`. */
  placement?: ToastPlacement
}

const placementClass: Record<ToastPlacement, string> = {
  bottom: 'inset-x-0 bottom-6 justify-center px-4',
  'top-right': 'inset-x-4 top-4 justify-end',
}

/**
 * A short message at the bottom centre of the window (or its top right), above
 * panes, full-screen panes and dialogs. Screen readers announce it without
 * moving focus: an error at once, interrupting, and anything else when they are idle.
 */
export function Toast({ message, kind, placement = 'bottom' }: Props) {
  return (
    <div className={`pointer-events-none fixed z-[60] flex ${placementClass[placement]}`}>
      <div
        role={kind === 'error' ? 'alert' : 'status'}
        data-placement={placement}
        aria-live={kind === 'error' ? 'assertive' : 'polite'}
        className={`anim-pop flex max-w-full items-center gap-2 rounded-md border bg-raised px-3 py-1.5 text-xs shadow-xl ${
          kind === 'error' ? 'border-bad/50 text-bad' : 'border-line text-ink'
        }`}
      >
        {kind === 'error' ? <CircleAlert size={13} /> : <Check size={13} className="text-good" />}
        <span className="min-w-0 truncate font-mono">{message}</span>
      </div>
    </div>
  )
}
