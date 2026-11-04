import { loadRootEnv, requiredEnv, urlFromEnv } from '@orch/shared/env'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

loadRootEnv()

export default defineConfig({
  server: { host: requiredEnv('WEB_HOST'), port: Number(requiredEnv('WEB_PORT')), strictPort: true },
  // The page talks to the host straight on its loopback address, so the page carries where that is.
  define: { 'import.meta.env.VITE_HOST_URL': JSON.stringify(urlFromEnv('HOST_HOST', 'HOST_PORT')) },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})
