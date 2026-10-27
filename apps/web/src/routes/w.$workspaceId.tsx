import { createFileRoute } from '@tanstack/react-router'

// The root layout renders the page for this route through <TerminalUI>, reading `workspaceId` from the URL.
export const Route = createFileRoute('/w/$workspaceId')({})
