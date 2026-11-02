import { Menu, MenuItem, MenuLinkItem, MenuPopup, MenuTrigger } from '@orch/ui'
import { ChevronDown, CircleUser, X } from '@orch/ui/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { sessionQuery, signOut } from '../lib/auth'
import { focusClass } from './Centered'

/**
 * A button showing the signed-in user's email, which opens a menu with the account page and sign out. It reads the
 * session itself, so a memoized parent needs no user dependency. Renders nothing while signed out.
 */
export function AccountMenu({ className = '' }: { className?: string }) {
  const user = useQuery(sessionQuery).data
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [signOutFailed, setSignOutFailed] = useState(false)
  const button = useRef<HTMLButtonElement>(null)

  if (!user) return null

  const onSignOut = async () => {
    setSignOutFailed(false)
    try {
      await signOut(queryClient)
      await navigate({ to: '/auth/sign-in' })
    } catch {
      setSignOutFailed(true)
    }
  }

  return (
    <div className={`relative ${className}`}>
      <Menu
        onOpenChange={(open) => {
          // The error panel sits where the menu opens, so it would cover the menu's items.
          if (open) setSignOutFailed(false)
        }}
      >
        <MenuTrigger
          ref={button}
          title={user.email}
          className={`flex max-w-full items-center gap-1.5 px-1.5 py-0.5 text-xs text-dim hover:bg-raised hover:text-ink active:bg-line data-popup-open:bg-raised data-popup-open:text-ink ${focusClass}`}
        >
          <CircleUser size={13} className="shrink-0" />
          <span className="min-w-0 truncate">{user.email}</span>
          <ChevronDown size={12} className="shrink-0" />
        </MenuTrigger>
        <MenuPopup aria-label="Account">
          <MenuLinkItem render={<Link to="/account" />}>Account</MenuLinkItem>
          <MenuItem onClick={() => void onSignOut()}>Sign out</MenuItem>
        </MenuPopup>
      </Menu>
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
