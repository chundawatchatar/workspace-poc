import mdx from '@astrojs/mdx'
import react from '@astrojs/react'
import { loadRootEnv, requiredEnv, urlFromEnv } from '@orch/shared/env'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

loadRootEnv()
const siteUrl = requiredEnv('SITE_URL')

export default defineConfig({
  site: siteUrl,
  server: { host: requiredEnv('SITE_HOST'), port: Number(requiredEnv('SITE_PORT')) },
  output: 'static',
  integrations: [react(), mdx()],
  // Code blocks take the active theme's colours from site.css rather than a fixed highlighter theme.
  markdown: { syntaxHighlight: false },
  vite: {
    server: { strictPort: true },
    define: {
      'import.meta.env.PUBLIC_SITE_URL': JSON.stringify(siteUrl),
      'import.meta.env.PUBLIC_LOCAL_URL': JSON.stringify(urlFromEnv('WEB_HOST', 'WEB_PORT')),
    },
    plugins: [tailwindcss()],
  },
})
