import { WorkspaceView } from '@orch/terminal-ui'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/m/$machineId/w/$workspaceId')({ component: Workspace })

function Workspace() {
  const { workspaceId } = Route.useParams()
  return <WorkspaceView workspaceId={workspaceId} />
}
