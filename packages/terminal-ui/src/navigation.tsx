import { type AnchorHTMLAttributes, createContext, type MouseEvent, useContext } from 'react'

export interface Navigation {
  /** The workspace in the app's URL, or `undefined` on the home page. */
  workspaceId: string | undefined
  navigate: (target: { workspaceId?: string }, options?: { replace?: boolean }) => void
  workspaceHref: (workspaceId: string) => string
}

const NavigationContext = createContext<Navigation | null>(null)

export const NavigationProvider = NavigationContext.Provider

/** Where the page is and how to move, as the app's router sees it. */
export function useNavigation(): Navigation {
  const navigation = useContext(NavigationContext)
  if (!navigation) throw new Error('useNavigation must be used inside <TerminalUI>')
  return navigation
}

/** Opens a workspace in the app's URL. */
export function useGoToWorkspace() {
  const { navigate } = useNavigation()
  return (workspaceId: string) => navigate({ workspaceId })
}

/**
 * A real link to a workspace, so middle-click and "open in new tab" work, that navigates in place on a plain
 * left click unless a child already handled the click.
 */
export function WorkspaceLink({
  workspaceId,
  onClick,
  ...props
}: { workspaceId: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate, workspaceHref } = useNavigation()
  function click(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (props.target && props.target !== '_self') return
    event.preventDefault()
    navigate({ workspaceId })
  }
  return <a {...props} href={workspaceHref(workspaceId)} onClick={click} />
}
