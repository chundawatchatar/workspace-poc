import { CircleAlert, Hand, LoaderCircle, type LucideIcon, Pause } from '@orch/ui/icons'
import type { AgentStatus, AgentStatusKind } from '../lib/agentStatus'

/** The shape and status colour of each kind. */
export const AGENT_MARKS: Record<AgentStatusKind, { Icon: LucideIcon; colour: string }> = {
  working: { Icon: LoaderCircle, colour: '' },
  waiting: { Icon: Hand, colour: 'text-warn' },
  idle: { Icon: Pause, colour: 'text-faint' },
  failed: { Icon: CircleAlert, colour: 'text-bad' },
}

/**
 * Draws a status, told apart by shape as well as colour. `onAccent` is for the
 * selected sidebar tile, where the theme's status colours would not show.
 */
export function AgentStateMark(props: { status: AgentStatus; size: number; onAccent?: boolean }) {
  const { Icon, colour } = AGENT_MARKS[props.status.kind]
  const spin = props.status.kind === 'working' ? 'animate-spin' : ''
  return (
    <Icon
      size={props.size}
      role="img"
      aria-label={props.status.label}
      className={`${spin} ${props.onAccent ? 'text-on-accent' : colour}`.trim()}
    />
  )
}
