import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'
import { Menu as BaseMenu } from '@base-ui/react/menu'
import type { ReactNode, SyntheticEvent } from 'react'
import { cn } from './lib/utils'

const popupClass = 'anim-pop min-w-36 rounded-md border border-line bg-raised py-1 shadow-xl outline-none'
const itemClass =
  'flex w-full cursor-default items-center gap-2 px-2.5 py-1.5 text-left text-xs text-ink outline-none select-none data-disabled:opacity-60 data-highlighted:bg-accent/20'

// The popup is portalled, but React still bubbles its events to the component that owns the menu, such as a tab that
// selects itself on click. They stop here.
const stop = (event: SyntheticEvent) => event.stopPropagation()
const stopContextMenu = (event: SyntheticEvent) => {
  event.preventDefault()
  event.stopPropagation()
}
const popupEvents = { onClick: stop, onDoubleClick: stop, onContextMenu: stopContextMenu }

/**
 * A dropdown menu opened from a `MenuTrigger`. It handles focus, arrow keys, typeahead, Escape and outside clicks.
 * Not modal, so the page keeps scrolling and a click outside reaches what it lands on.
 */
export function Menu(props: BaseMenu.Root.Props) {
  return <BaseMenu.Root modal={false} {...props} />
}

/** The button that opens a `Menu`. Renders a `<button>`; style it like any button. */
export const MenuTrigger = BaseMenu.Trigger

/** A `Menu`'s list, rendered in the body below its trigger, so a scrolling or narrow parent can't clip it. */
export function MenuPopup(props: {
  children: ReactNode
  /** Which edge of the trigger the menu lines up with. */
  align?: 'start' | 'end'
  'aria-label'?: string
  className?: string
}) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner className="z-50 outline-none" side="bottom" align={props.align ?? 'end'} sideOffset={4}>
        <BaseMenu.Popup aria-label={props['aria-label']} className={cn(popupClass, props.className)} {...popupEvents}>
          {props.children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  )
}

/** A menu opened by right click or long press on its `ContextMenuTrigger`, at the pointer. */
export function ContextMenu(props: BaseContextMenu.Root.Props) {
  return <BaseContextMenu.Root {...props} />
}

/** The area that opens a `ContextMenu`. Renders a `<div>`, or the element given in `render`. */
export const ContextMenuTrigger = BaseContextMenu.Trigger

/** A `ContextMenu`'s list, rendered in the body at the pointer and kept inside the window. */
export function ContextMenuPopup(props: { children: ReactNode; 'aria-label'?: string; className?: string }) {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner className="z-50 outline-none">
        <BaseContextMenu.Popup
          aria-label={props['aria-label']}
          className={cn(popupClass, props.className)}
          {...popupEvents}
        >
          {props.children}
        </BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  )
}

type ItemProps = Omit<BaseMenu.Item.Props, 'className'> & { icon?: ReactNode; className?: string }

/** An action in a `MenuPopup` or `ContextMenuPopup`. Closes the menu when chosen. */
export function MenuItem({ icon, className, children, ...props }: ItemProps) {
  return (
    <BaseMenu.Item className={cn(itemClass, className)} {...props}>
      {icon && <span className="shrink-0 text-dim">{icon}</span>}
      {children}
    </BaseMenu.Item>
  )
}

type LinkItemProps = Omit<BaseMenu.LinkItem.Props, 'className'> & { icon?: ReactNode; className?: string }

/**
 * A link in a menu. Pass the app's router link in `render` (`render={<Link to="/account" />}`). Unlike Base UI's
 * default, it closes the menu, since a client-side navigation may keep the menu on screen.
 */
export function MenuLinkItem({ icon, className, children, ...props }: LinkItemProps) {
  return (
    <BaseMenu.LinkItem closeOnClick className={cn(itemClass, className)} {...props}>
      {icon && <span className="shrink-0 text-dim">{icon}</span>}
      {children}
    </BaseMenu.LinkItem>
  )
}
