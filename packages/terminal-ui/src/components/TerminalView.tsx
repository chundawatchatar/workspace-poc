import { TerminalView as TerminalViewBase, themeById } from '@orch/ui'
import { useCallback } from 'react'
import { useApp } from '../lib/store'
import { useTransport } from '../transportContext'

/** The shared terminal view, connected through the page's transport and theme. */
export function TerminalView(props: { sessionId: string; cwd: string; active: boolean }) {
  const theme = useApp((s) => themeById(s.themeId)?.terminal)
  const online = useApp((s) => s.status === 'open')
  const transport = useTransport()
  const openSocket = useCallback((path: string) => transport.openSocket(path), [transport])
  return <TerminalViewBase openSocket={openSocket} theme={theme} online={online} {...props} />
}
