import { TerminalView as TerminalViewBase, themeById } from '@orch/ui'
import { HOST_WS, useApp } from '../lib/store'

/** The shared terminal view, connected to this app's host and theme. */
export function TerminalView(props: { sessionId: string; cwd: string; active: boolean }) {
  const theme = useApp((s) => themeById(s.themeId)?.terminal)
  return <TerminalViewBase hostUrl={HOST_WS} theme={theme} {...props} />
}
