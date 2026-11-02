import { type AgentStateCounts, agentCountsLabel } from '../lib/agentStatus'
import { AGENT_MARKS } from './AgentStateMark'

const ORDER = ['waiting', 'working', 'idle'] as const

/**
 * Draws a workspace's agent counts as an icon and a number per state. It draws
 * nothing with no counts. The words go in the row's link name, so the drawing
 * is hidden from screen readers. `active` is for the selected sidebar tile.
 */
export function AgentCounts({ counts, active }: { counts: AgentStateCounts; active: boolean }) {
  const label = agentCountsLabel(counts)
  if (!label) return null
  const colours = {
    waiting: active ? 'text-on-accent' : 'text-accent',
    other: active ? 'text-on-accent/70' : 'text-dim',
  }
  return (
    <>
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" title={label} className="flex shrink-0 items-center gap-1.5 text-[10px]">
        {ORDER.filter((state) => counts[state] > 0).map((state) => {
          const { Icon } = AGENT_MARKS[state]
          return (
            <span
              key={state}
              className={`flex items-center gap-0.5 ${state === 'waiting' ? colours.waiting : colours.other}`}
            >
              <Icon size={10} />
              {counts[state]}
            </span>
          )
        })}
      </span>
    </>
  )
}
