import { loadRootEnv, requiredEnv, urlFromEnv } from '@orch/shared/env'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

loadRootEnv()

export default defineConfig(({ command, isPreview }) => {
  // TanStack's prerender loads this config again for a preview server, so only `vite dev` reads the dev addresses.
  const dev = command === 'serve' && !isPreview
  return {
    ...(dev && {
      server: { host: requiredEnv('WEB_HOST'), port: Number(requiredEnv('WEB_PORT')), strictPort: true },
      // The dev page is served from `WEB_PORT` and talks to the host straight on its loopback address, so it carries
      // where that is. A build carries no address: the host serves it and it talks to the page's own origin.
      define: { 'import.meta.env.VITE_HOST_URL': JSON.stringify(urlFromEnv('HOST_HOST', 'HOST_PORT')) },
    }),
    // The build is a static folder: `dist/index.html` (the prerendered SPA shell) and its assets, which the host
    // serves from `HOST_STATIC_DIR`. The server bundle only exists to prerender the shell, so it goes to `.output`.
    environments: {
      client: { build: { outDir: 'dist' } },
      ssr: { build: { outDir: '.output/server' } },
    },
    plugins: [
      tailwindcss(),
      tanstackStart({ spa: { enabled: true, prerender: { outputPath: '/index' } } }),
      viteReact(),
    ],
  }
})
