import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import type { ReactNode } from 'react'
import { cn } from './lib/utils'

interface DialogProps {
  /** The dialog's accessible name, for a dialog without a visible title. */
  'aria-label'?: string
  children: ReactNode
  /** Classes for the panel: its width, height and layout. */
  className?: string
  /** Classes for the backdrop, such as a lighter tint. */
  backdropClassName?: string
  /** Classes for the box the panel sits in, such as its distance from the top of the window. */
  viewportClassName?: string
  /** Called when the user dismisses it with Escape or a click outside. The dialog is open while it is rendered. */
  onClose: () => void
}

/**
 * A bare modal dialog, open while rendered: it traps focus, locks page scroll, hides the page from screen readers,
 * closes on Escape or a click outside, and gives focus back to where it was when it closes. Draws only the panel, so
 * use `Modal` for the usual titled one.
 */
export function Dialog(props: DialogProps) {
  return (
    <BaseDialog.Root open onOpenChange={(open) => !open && props.onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={cn('anim-backdrop fixed inset-0 z-50 bg-black/55', props.backdropClassName)} />
        <BaseDialog.Viewport
          className={cn('fixed inset-0 z-50 flex items-start justify-center pt-[14vh]', props.viewportClassName)}
        >
          <BaseDialog.Popup
            aria-label={props['aria-label']}
            className={cn(
              'anim-dialog rounded-lg border border-line bg-sidebar shadow-2xl outline-none',
              props.className,
            )}
          >
            {props.children}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

/** A titled modal dialog, open while rendered. See `Dialog` for what it handles. */
export function Modal(props: { title: string; children: ReactNode; width?: string; onClose: () => void }) {
  return (
    <Dialog className={props.width ?? 'w-[440px]'} onClose={props.onClose}>
      {/* The title also names the dialog for screen readers. */}
      <BaseDialog.Title className="border-b border-line px-4 py-3 text-sm font-semibold">
        {props.title}
      </BaseDialog.Title>
      <div className="p-4">{props.children}</div>
    </Dialog>
  )
}
