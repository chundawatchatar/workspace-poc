import type { ConnectionStatus } from './store'

/** How the page describes a connection status. */
export interface ConnectionCopy {
  /** The sidebar footer's label. */
  label: string
  /** The class of the dot beside the label. */
  dot: 'bg-good' | 'bg-warn' | 'bg-bad'
  /** Shown in place of the page before the layout has loaded. */
  message: string
  /** Shown above the page once the layout has loaded; null means no banner. */
  banner: string | null
  /** Which of the app's hints follows the text, if any. */
  hint: 'offline' | 'denied' | null
  /** True when the page offers a "Try again" button that calls `reconnect`. */
  retry: boolean
}

const COPY: Record<ConnectionStatus, ConnectionCopy> = {
  connecting: {
    label: 'Connecting…',
    dot: 'bg-warn',
    message: 'Connecting to the host…',
    banner: 'Connecting to the host…',
    hint: null,
    retry: false,
  },
  open: {
    label: 'Host connected',
    dot: 'bg-good',
    message: 'Connecting to the host…',
    banner: null,
    hint: null,
    retry: false,
  },
  reconnecting: {
    label: 'Reconnecting…',
    dot: 'bg-warn',
    message: 'The host is not running.',
    banner: 'Connection lost. Reconnecting…',
    hint: 'offline',
    retry: false,
  },
  offline: {
    label: 'Machine offline',
    dot: 'bg-bad',
    message: 'The machine is offline.',
    banner: "The machine is offline. Terminals reattach when it's back.",
    hint: 'offline',
    retry: false,
  },
  denied: {
    label: 'Access denied',
    dot: 'bg-bad',
    message: 'The access key was rejected.',
    banner: 'The access key was rejected.',
    hint: 'denied',
    retry: true,
  },
}

/** The labels and texts for a connection status, shared by the sidebar, `HostStatus` and `ConnectionBanner`. */
export function connectionCopy(status: ConnectionStatus): ConnectionCopy {
  return COPY[status]
}
