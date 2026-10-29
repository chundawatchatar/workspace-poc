import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Where `/api` goes in dev: the cloud server, which will serve the accounts API on its own origin in production.
const apiTarget = process.env.CLIENT_API_TARGET || 'http://127.0.0.1:4600'

export default defineConfig({
  server: { host: '127.0.0.1', proxy: { '/api': { target: apiTarget } } },
  preview: { host: '127.0.0.1' },
  // The build is a static folder: `dist/index.html` (the prerendered SPA shell) and its assets, which `apps/server`
  // serves. The server bundle only exists to prerender the shell, so it goes to `.output` and is never deployed.
  environments: {
    client: { build: { outDir: 'dist' } },
    ssr: { build: { outDir: '.output/server' } },
  },
  plugins: [tailwindcss(), tanstackStart({ spa: { enabled: true, prerender: { outputPath: '/index' } } }), viteReact()],
})
