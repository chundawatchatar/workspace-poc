import { ChevronDown, CircleUser, X } from '@orch/ui/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { sessionQuery, signOut } from '../lib/auth'
import { focusClass } from './Centered'

const itemClass =
  'block w-full px-3 py-1.5 text-left text-xs text-ink outline-none hover:bg-raised focus-visible:bg-raised'

/**
 * A button showing the signed-in user's email, which opens a menu with the account page and sign out. It reads the
 * session itself, so a memoized parent needs no user dependency. Renders nothing while signed out.
 */
export function AccountMenu({ className = '' }: { className?: string }) {
  const user = useQuery(sessionQuery).data
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [signOutFailed, setSignOutFailed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    // Capture, so a focused terminal can't swallow the key first.
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  if (!user) return null

  const onMenuKeyDown = (event: KeyboardEvent) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length]?.focus()
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }
  const onSignOut = async () => {
    setOpen(false)
    setSignOutFailed(false)
    try {
      await signOut(queryClient)
      await navigate({ to: '/auth/sign-in' })
    } catch {
      setSignOutFailed(true)
    }
  }

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={user.email}
        className={`flex max-w-full items-center gap-1.5 px-1.5 py-0.5 text-xs text-dim hover:bg-raised hover:text-ink active:bg-line ${focusClass}`}
        onClick={() => {
          // The error panel sits where the menu opens, so it would cover the menu's items.
          setSignOutFailed(false)
          setOpen((was) => !was)
        }}
      >
        <CircleUser size={13} className="shrink-0" />
        <span className="min-w-0 truncate">{user.email}</span>
        <ChevronDown size={12} className="shrink-0" />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Account"
          tabIndex={-1}
          className="absolute right-0 top-full z-50 mt-1 min-w-36 overflow-hidden rounded-md border border-line bg-panel py-1 shadow-lg"
          onKeyDown={onMenuKeyDown}
        >
          <Link to="/account" role="menuitem" className={itemClass} onClick={() => setOpen(false)}>
            Account
          </Link>
          <button type="button" role="menuitem" className={itemClass} onClick={() => void onSignOut()}>
            Sign out
          </button>
        </div>
      )}
      {signOutFailed && (
        // Capped below the narrowest sidebar (180px), which clips what overflows it, and opaque, since it floats
        // over whatever is below the button.
        <div className="absolute right-0 top-full z-50 mt-1 flex w-max max-w-40 items-start gap-1 rounded-md border border-line bg-panel py-1 pl-2 pr-1 text-xs text-bad shadow-lg">
          <p role="alert" className="min-w-0 flex-1 py-0.5">
            Signing out failed. Try again.
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            className={`shrink-0 p-0.5 text-dim hover:bg-raised hover:text-ink ${focusClass}`}
            onClick={() => {
              setSignOutFailed(false)
              button.current?.focus()
            }}
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
