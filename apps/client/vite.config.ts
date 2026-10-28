import { SIDEBAR_BOOT_SCRIPT } from '@orch/terminal-ui'
import { THEME_BOOT_SCRIPT } from '@orch/ui'
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/** Inlines the theme and sidebar boot scripts into the document head, so they run before the first paint. */
function bootScripts(): Plugin {
  return {
    name: 'orch-boot-scripts',
    transformIndexHtml: () => [
      { tag: 'script', children: `${THEME_BOOT_SCRIPT};${SIDEBAR_BOOT_SCRIPT}`, injectTo: 'head-prepend' },
    ],
  }
}

export default defineConfig({
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  plugins: [bootScripts(), tailwindcss(), viteReact()],
})
