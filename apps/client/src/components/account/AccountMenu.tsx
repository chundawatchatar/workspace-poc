import { Menu, MenuItem, MenuLinkItem, MenuPopup, MenuTrigger, showToast } from '@orch/ui'
import { ChevronDown, CircleUser } from '@orch/ui/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { sessionQuery, signOut } from '../../lib/auth'
import { focusClass } from '../Centered'

/**
 * A button showing the signed-in user's email, which opens a menu with the account page and sign out. It reads the
 * session itself, so a memoized parent needs no user dependency. Renders nothing while signed out.
 */
export function AccountMenu({ className = '' }: { className?: string }) {
  const user = useQuery(sessionQuery).data
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  if (!user) return null

  const onSignOut = async () => {
    try {
      await signOut(queryClient)
      await navigate({ to: '/auth/sign-in' })
    } catch {
      showToast('Signing out failed. Try again.', 'error', { placement: 'top-right' })
    }
  }

  return (
    <Menu>
      <MenuTrigger
        title={user.email}
        className={`flex max-w-full items-center gap-1.5 px-1.5 py-0.5 text-xs text-dim hover:bg-raised hover:text-ink active:bg-line data-popup-open:bg-raised data-popup-open:text-ink ${focusClass} ${className}`}
      >
        <CircleUser size={13} className="shrink-0" />
        <span className="min-w-0 truncate">{user.email}</span>
        <ChevronDown size={12} className="shrink-0" />
      </MenuTrigger>
      <MenuPopup aria-label="Account">
        <MenuLinkItem render={<Link to="/settings/account" />}>Settings</MenuLinkItem>
        <MenuItem onClick={() => void onSignOut()}>Sign out</MenuItem>
      </MenuPopup>
    </Menu>
  )
}
