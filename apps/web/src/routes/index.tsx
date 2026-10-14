import { createFileRoute, Navigate } from '@tanstack/react-router'
import { HostStatus } from '../components/HostStatus'
import { setOverlay, useApp } from '../lib/store'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const state = useApp((s) => s.state)
  if (!state) return <HostStatus />
  const first = state.workspaces[0]
  if (first) return <Navigate to="/w/$workspaceId" params={{ workspaceId: first.id }} replace />
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-dim">
      <p>No workspaces yet.</p>
      <button
        type="button"
        className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent"
        onClick={() => setOverlay('new-workspace')}
      >
        New workspace
      </button>
    </div>
  )
}
