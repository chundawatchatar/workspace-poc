import { HomeView } from '@orch/terminal-ui'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: HomeView })
