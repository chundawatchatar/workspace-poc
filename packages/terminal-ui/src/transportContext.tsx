import { createContext, useContext } from 'react'
import type { HostTransport } from './transport'

const TransportContext = createContext<HostTransport | null>(null)

export const TransportProvider = TransportContext.Provider

/** The transport passed to `<TerminalUI>`. */
export function useTransport(): HostTransport {
  const transport = useContext(TransportContext)
  if (!transport) throw new Error('useTransport must be used inside <TerminalUI>')
  return transport
}
