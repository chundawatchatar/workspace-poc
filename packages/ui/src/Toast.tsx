import { Check, CircleAlert } from './icons'

interface Props {
  message: string
  kind: 'info' | 'error'
}

/**
 * A short message at the bottom centre of the window, above panes, full-screen
 * panes and dialogs. Screen readers announce it without moving focus.
 */
export function Toast({ message, kind }: Props) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
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
