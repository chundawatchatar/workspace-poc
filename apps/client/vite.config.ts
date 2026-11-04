import { loadRootEnv, requiredEnv, urlFromEnv } from '@orch/shared/env'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

loadRootEnv()
const host = requiredEnv('CLIENT_HOST')
const port = Number(requiredEnv('CLIENT_PORT'))
// In dev, the cloud server sits behind this origin, as it does in production, where it serves the client itself:
// the accounts API and the machines it relays under `/m/<id>`, but not the client's own `/m/<id>` pages.
const target = urlFromEnv('SERVER_HOST', 'SERVER_PORT')

export default defineConfig({
  server: {
    host,
    port,
    strictPort: true,
    // Written out rather than imported from `@orch/shared`: TanStack's prerender starts Vite's preview with Node's own
    // loader, which can't load that package's entry, so this config imports only `@orch/shared/env`.
    proxy: {
      '/api': { target },
      '^/m/[^/]+/(api|ws)/': { target, ws: true },
    },
  },
  preview: { host, port, strictPort: true },
  // The build is a static folder: `dist/index.html` (the prerendered SPA shell) and its assets, which `apps/server`
  // serves. The server bundle only exists to prerender the shell, so it goes to `.output` and is never deployed.
  environments: {
    client: { build: { outDir: 'dist' } },
    ssr: { build: { outDir: '.output/server' } },
  },
  plugins: [tailwindcss(), tanstackStart({ spa: { enabled: true, prerender: { outputPath: '/index' } } }), viteReact()],
})
