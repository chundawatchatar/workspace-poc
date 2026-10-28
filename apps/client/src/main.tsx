import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { acceptConnectLink } from './lib/machines'
import { createAppRouter } from './router'
import './styles.css'

// A connect link works on any path. Read it before the router does, so the router
// starts on the machine's page and the key never reaches the router's history.
acceptConnectLink()
const router = createAppRouter()

window.addEventListener('hashchange', () => {
  const machineId = acceptConnectLink()
  if (machineId) void router.navigate({ to: '/m/$machineId', params: { machineId }, replace: true })
})

const root = document.getElementById('root')
if (!root) throw new Error('index.html has no #root element')
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
