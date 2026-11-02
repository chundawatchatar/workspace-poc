import { NotFound } from '@orch/terminal-ui'
import { createFileRoute } from '@tanstack/react-router'

// Without it, the root's catch-all would take unknown paths under a machine away from the machine's page.
export const Route = createFileRoute('/m/$machineId/$')({ component: NotFound })
