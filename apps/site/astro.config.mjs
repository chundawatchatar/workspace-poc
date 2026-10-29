import mdx from '@astrojs/mdx'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

export default defineConfig({
  // Placeholder until the domain is decided; keep in step with `domain` in src/site.config.ts.
  site: 'https://orchestrator.example.com',
  output: 'static',
  integrations: [react(), mdx()],
  // Code blocks take the active theme's colours from site.css rather than a fixed highlighter theme.
  markdown: { syntaxHighlight: false },
  vite: { plugins: [tailwindcss()] },
})
