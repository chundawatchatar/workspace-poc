import { trustQuestion, unansweredAgent, useAgentTrackingAnswers, useAnswerAgentTracking } from '../lib/agentTracking'
import { useApp } from '../lib/store'

/**
 * Asks once per agent kind whether to track it with hooks, on every terminal running that kind until the user
 * answers. It is a strip over the top of the terminal, not a dialog, so the agent's own prompts stay usable.
 */
export function TrustNotice({ sessionId }: { sessionId: string }) {
  const session = useApp((s) => s.sessions[sessionId])
  const answers = useAgentTrackingAnswers(Boolean(session?.agent))
  const answer = useAnswerAgentTracking()
  const kind = unansweredAgent(session, answers)
  if (!kind) return null
  const question = trustQuestion(kind)
  return (
    <section
      aria-label={question.title}
      className="anim-fade absolute inset-x-0 top-0 z-10 flex items-start gap-3 border-b border-line bg-sidebar px-3 py-2 shadow-md"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-ink">{question.title}</p>
        <p className="mt-0.5 text-xs text-dim">{question.body}</p>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <button
          type="button"
          className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-on-accent"
          onClick={() => answer(kind, 'on')}
        >
          Track
        </button>
        <button
          type="button"
          className="rounded px-2.5 py-1 text-xs text-dim hover:bg-raised"
          onClick={() => answer(kind, 'off')}
        >
          Not now
        </button>
      </div>
    </section>
  )
}
