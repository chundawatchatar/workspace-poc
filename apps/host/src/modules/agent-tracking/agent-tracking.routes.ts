import { routes } from '@orch/shared'
import { createRouter } from '../../lib/createRouter'
import type { AgentTrackingService } from './agent-tracking.service'

/** What the agent tracking routes need from the host. */
export interface AgentTrackingDeps {
  agentTracking: Pick<AgentTrackingService, 'status' | 'update'>
}

/** Serves `routes.agentTracking`. Remote clients may answer too, like `ack`; the answers hold nothing secret. */
export function createAgentTrackingRoutes({ agentTracking }: AgentTrackingDeps) {
  return createRouter(routes.agentTracking, {
    status: async () => agentTracking.status(),
    update: async (input) => agentTracking.update(input),
  })
}
