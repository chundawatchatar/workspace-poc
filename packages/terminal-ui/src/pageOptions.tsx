import { createContext, type ReactNode, useContext } from 'react'

/** The parts of the page an app fills in for itself. */
export interface PageOptions {
  /** The machine this page is for; its name replaces the "Workspaces" label in the sidebar. */
  machine: { id: string; name: string } | undefined
  /** Rendered at the top of the sidebar. */
  header: ReactNode
  /** Shown under "The host is not running." and "The machine is offline." */
  offlineHint: ReactNode
  /** Shown under "The access key was rejected." */
  deniedHint: ReactNode
  /** Follows the workspace name in the document title. */
  titleSuffix: string
  /** True when the page offers the Remote access setting, which only a local page can change. */
  remoteAccessSetting: boolean
}

const PageOptionsContext = createContext<PageOptions | null>(null)

export const PageOptionsProvider = PageOptionsContext.Provider

/** The options passed to `<TerminalUI>`, with their defaults filled in. */
export function usePageOptions(): PageOptions {
  const options = useContext(PageOptionsContext)
  if (!options) throw new Error('usePageOptions must be used inside <TerminalUI>')
  return options
}
