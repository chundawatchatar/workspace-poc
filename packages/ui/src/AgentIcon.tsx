import { AGENT_KINDS, type AgentKind, type AgentMark, agentDefinition } from '@orch/agents'
import { AgentMonogram } from './AgentMonogram'
import { cn } from './lib/utils'

export type { AgentMark } from '@orch/agents'

/** The identity artwork and fallback initials used by tabs and sidebar rows. */
export const AGENT_ICONS = Object.fromEntries(
  AGENT_KINDS.map((kind) => {
    const { initials, icon } = agentDefinition(kind)
    return [kind, { label: initials, mark: icon }]
  }),
) as Readonly<Record<AgentKind, Readonly<{ label: string; mark?: AgentMark }>>>

/**
 * Draws which agent runs in a terminal: its vendor's mark where one is
 * permitted, otherwise its monogram in the text colour around it. It is
 * decorative: the agent's name is in the tooltip or the row's text beside it.
 */
export function AgentIcon({ kind, size, className }: { kind: AgentKind; size: number; className?: string }) {
  const { label, mark } = AGENT_ICONS[kind]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-agent={kind}
      className={cn('shrink-0', className)}
    >
      {mark ? <Mark mark={mark} /> : <AgentMonogram label={label} />}
    </svg>
  )
}

function Mark({ mark }: { mark: AgentMark }) {
  const box = 16 - 2 * mark.inset
  return (
    <svg
      x={mark.inset}
      y={mark.inset}
      width={box}
      height={box}
      viewBox={mark.viewBox}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {mark.paths.map((path) => (
        <path
          key={path.d}
          d={path.d}
          fill={mark.colors === 'currentColor' ? 'currentColor' : path.fill}
          fillOpacity={path.fillOpacity}
          fillRule={path.fillRule}
          clipRule={path.clipRule}
        />
      ))}
    </svg>
  )
}
