import {
  AGENT_LABELS,
  type AgentTrackingAnswer,
  type AgentTrackingStatus,
  routes,
  type SessionInfo,
  type TrackedAgent,
  trackedAgent,
} from '@orch/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { apiKey, apiMutation, apiQuery } from './api'
import { showToast } from './toast'

/** True for an agent kind whose hooks the product can attach. */
export function isTrackedAgent(kind: string | undefined): kind is TrackedAgent {
  return trackedAgent.safeParse(kind).success
}

/**
 * The agent kind to ask about in a terminal: its agent, when hooks can track it and the user has not answered for
 * that kind yet. Null while the answers are unknown, so nothing flashes before they load, and in a terminal whose
 * switch is off, where Track would change nothing.
 */
export function unansweredAgent(
  session: Pick<SessionInfo, 'agent' | 'agentTracking'> | undefined,
  answers: AgentTrackingStatus | undefined,
): TrackedAgent | null {
  const kind = session?.agent?.kind
  if (!answers || !session?.agentTracking || !isTrackedAgent(kind)) return null
  return answers[kind] === null ? kind : null
}

/** The question the notice asks, in the agent's own name. */
export function trustQuestion(kind: TrackedAgent) {
  const label = AGENT_LABELS[kind]
  return {
    title: `Track ${label}'s status with hooks?`,
    body:
      `This adds hooks to ${label} sessions started in this app, for those sessions only. Your settings are not ` +
      `changed. It applies to ${label} started after you answer; a terminal already open gets it once its shell ` +
      'starts again or in a new tab.',
  }
}

/** What the per-terminal switch does, in short, for the palette. */
export const SWITCH_SHORT_HINT = 'Hooks return once the shell starts again'

/** The tooltip of the per-terminal switch, which says when hooks come back. */
export const SWITCH_HINT =
  'Turning it off clears the agent state now. Turning it on brings the state back at once, and hooks once the shell starts again or in a new tab.'

/** The user's trust answers from the host. Fetched only when `enabled`, such as while an agent runs. */
export function useAgentTrackingAnswers(enabled = true) {
  return useQuery({ ...apiQuery(routes.agentTracking.status, {}), enabled }).data
}

/**
 * Stores a trust answer with `answer`. Every view of the answers reloads once the host has it. `pending` is true
 * while one is on its way.
 */
export function useAnswerAgentTracking() {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    ...apiMutation(routes.agentTracking.update),
    onSuccess: (status) => queryClient.setQueryData(apiKey(routes.agentTracking.status, {}), status),
    onError: () => showToast('Could not save the answer', 'error'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: apiKey(routes.agentTracking.status, {}) }),
  })
  const { mutate } = mutation
  const answer = useCallback(
    (agent: TrackedAgent, value: AgentTrackingAnswer) => mutate({ agent, answer: value }),
    [mutate],
  )
  return { answer, pending: mutation.isPending }
}
