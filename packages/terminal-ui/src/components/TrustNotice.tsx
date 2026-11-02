import { Button } from '@orch/ui'
import { trustQuestion, unansweredAgent, useAgentTrackingAnswers, useAnswerAgentTracking } from '../lib/agentTracking'
import { useApp } from '../lib/store'

/**
 * Asks once per agent kind whether to track it with hooks, on every terminal running that kind until the user
 * answers. It sits above the terminal, not over it or in a dialog, so the agent's own prompts stay visible and usable.
 */
export function TrustNotice({ sessionId }: { sessionId: string }) {
  const session = useApp((s) => s.sessions[sessionId])
  const answers = useAgentTrackingAnswers(Boolean(session?.agent))
  const { answer, pending } = useAnswerAgentTracking()
  const kind = unansweredAgent(session, answers)
  if (!kind) return null
  const question = trustQuestion(kind)
  return (
    <section
      aria-label={question.title}
      className="anim-fade flex shrink-0 flex-wrap items-start gap-x-3 gap-y-2 border-b border-line bg-sidebar px-3 py-2"
    >
      <div className="min-w-48 flex-1">
        <p className="text-xs font-medium text-ink">{question.title}</p>
        <p className="mt-0.5 text-xs text-dim">{question.body}</p>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <Button className="px-2.5 py-1 text-xs" disabled={pending} onClick={() => answer(kind, 'on')}>
          Track
        </Button>
        <Button
          variant="secondary"
          className="px-2.5 py-1 text-xs"
          disabled={pending}
          onClick={() => answer(kind, 'off')}
        >
          Not now
        </Button>
      </div>
    </section>
  )
}
