import { NotFound } from '@orch/terminal-ui'
import { createFileRoute } from '@tanstack/react-router'
import { MachinePage } from '../components/MachinePage'

export const Route = createFileRoute('/m/$machineId')({
  component: Machine,
  // Rendered in the machine's outlet, so an unknown path keeps the machine's page around it.
  notFoundComponent: NotFound,
})

function Machine() {
  const { machineId } = Route.useParams()
  return <MachinePage machineId={machineId} />
}
