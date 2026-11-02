import { ArrowLeft, Bell, type LucideIcon, Palette, Shield, UserRound } from '@orch/ui/icons'
import { Link, Outlet } from '@tanstack/react-router'
import { focusClass } from '../Centered'

interface NavItem {
  to: '/settings/account' | '/settings/security' | '/settings/appearance' | '/settings/notifications'
  label: string
  icon: LucideIcon
}

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: 'Account',
    items: [
      { to: '/settings/account', label: 'Account', icon: UserRound },
      { to: '/settings/security', label: 'Security', icon: Shield },
    ],
  },
  {
    label: 'App',
    items: [
      { to: '/settings/appearance', label: 'Appearance', icon: Palette },
      { to: '/settings/notifications', label: 'Notifications', icon: Bell },
    ],
  },
]

const itemClass = `flex items-center gap-2 rounded-md px-2.5 py-1.5 whitespace-nowrap text-dim hover:bg-raised hover:text-ink data-[status=active]:bg-raised data-[status=active]:text-ink ${focusClass}`

/**
 * The frame of every settings page: a nav of the sections on the left (across the top on a narrow screen) and the
 * current section's page beside it, in one centred column that scrolls on its own.
 */
export function SettingsLayout() {
  return (
    <div className="flex h-full flex-col md:flex-row">
      <nav
        aria-label="Settings"
        className="flex shrink-0 gap-4 overflow-x-auto border-b border-line bg-sidebar p-3 md:w-72 md:flex-col md:overflow-x-visible md:border-r md:border-b-0"
      >
        <Link to="/" className={itemClass}>
          <ArrowLeft size={14} className="shrink-0" />
          Your machines
        </Link>
        {groups.map((group) => (
          <div key={group.label} className="flex gap-0.5 md:flex-col">
            <p className="hidden px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase md:block">
              {group.label}
            </p>
            {group.items.map((item) => (
              <Link key={item.to} to={item.to} className={itemClass}>
                <item.icon size={14} className="shrink-0" />
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8 sm:px-10">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
