import { createContext, type ReactNode, useContext } from 'react'

/** The parts of the page an app fills in for itself. */
export interface PageOptions {
  /** The machine this page is for; its name replaces the "Workspaces" label in the sidebar. */
  machine: { id: string; name: string } | undefined
  /** Rendered at the top of the sidebar. */
  header: ReactNode
  /** Rendered at the bottom left of the sidebar. */
  footer: ReactNode
  /** Shown under "The host is not running." and "The machine is offline." */
  offlineHint: ReactNode
  /** Shown under "This account can't open this machine." */
  deniedHint: ReactNode
  /** Shown while the machine waits for its owner to approve this browser. */
  unapprovedHint: ReactNode
  /** Follows the workspace name in the document title. */
  titleSuffix: string
  /** True when the page offers the Remote access setting, which only a local page can change. */
  remoteAccessSetting: boolean
  /** True when the sidebar shows the remote access status, which only a local page can read. */
  remoteAccessStatus: boolean
}

const PageOptionsContext = createContext<PageOptions | null>(null)

export const PageOptionsProvider = PageOptionsContext.Provider

/** The options passed to `<TerminalUI>`, with their defaults filled in. */
export function usePageOptions(): PageOptions {
  const options = useContext(PageOptionsContext)
  if (!options) throw new Error('usePageOptions must be used inside <TerminalUI>')
  return options
}
