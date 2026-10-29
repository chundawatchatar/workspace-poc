import { createFileRoute } from '@tanstack/react-router'
import { MachineList } from '../components/MachineList'
import { requireSession } from '../lib/auth'

export const Route = createFileRoute('/')({ beforeLoad: requireSession, component: MachineList })
