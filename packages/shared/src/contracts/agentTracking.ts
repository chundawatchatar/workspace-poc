import { z } from 'zod'
import { defineContract } from './contract'

/** The agents whose hooks the product can attach. The host checks this list against the tracked kinds. */
export const trackedAgent = z.enum(['claude', 'codex'])
export type TrackedAgent = z.infer<typeof trackedAgent>

/** The user's answer to "Track this agent's status with hooks?": `on` for Track, `off` for Not now. */
export const agentTrackingAnswer = z.enum(['on', 'off'])
export type AgentTrackingAnswer = z.infer<typeof agentTrackingAnswer>

/** The answer per agent kind. Null means the user was not asked yet, which behaves as off. */
export const agentTrackingStatus = z.strictObject({
  claude: agentTrackingAnswer.nullable(),
  codex: agentTrackingAnswer.nullable(),
})
export type AgentTrackingStatus = z.infer<typeof agentTrackingStatus>

export const updateAgentTrackingBody = z.strictObject({ agent: trackedAgent, answer: agentTrackingAnswer })
export type UpdateAgentTrackingBody = z.infer<typeof updateAgentTrackingBody>

export const agentTrackingContract = defineContract({
  status: {
    method: 'GET',
    path: '/api/agent-tracking/status',
    description: 'Reports whether the user agreed to hook tracking, per agent kind, so the UI asks only once.',
    input: z.object({}),
    output: agentTrackingStatus,
  },
  update: {
    method: 'POST',
    path: '/api/agent-tracking/answer',
    description:
      'Stores the answer for one agent kind and tells every open terminal its new tracking. Applies to agents started afterwards.',
    input: updateAgentTrackingBody,
    output: agentTrackingStatus,
  },
})
