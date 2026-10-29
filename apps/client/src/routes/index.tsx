import { createFileRoute } from '@tanstack/react-router'
import { MachineList } from '../components/MachineList'

export const Route = createFileRoute('/')({ component: MachineList })
