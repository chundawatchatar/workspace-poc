import { Hono } from 'hono'
import { tunnelPrincipal } from '../../lib/principal'
import { resolveUi, type UiSite } from './ui.service'

/** What the UI routes need from the host. Null or missing means there is no built UI to serve. */
export interface UiDeps {
  ui?: UiSite | null
}

const IMMUTABLE = 'public, max-age=31536000, immutable'

/** The CSP for every UI file but the page: a document opened from one gets an opaque origin and runs nothing. */
export const SANDBOX_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'"

/** The headers every UI response carries. */
const UI_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
}

/**
 * Serves the built local UI, from a folder or embedded in the executable: its
 * files byte for byte, and `index.html` for the UI's own routes. Mounted last, so every API and socket route wins. It
 * answers only local requests: one the tunnel authorized gets 404, so the
 * local UI is never served through `/m/<id>`. Every method but GET and HEAD
 * gets 404 too.
 */
export function createUiRoutes(site: UiSite) {
  return new Hono().all('*', async (c) => {
    if (tunnelPrincipal(c.env) || (c.req.method !== 'GET' && c.req.method !== 'HEAD')) return c.notFound()
    const acceptsHtml = c.req.header('accept')?.includes('text/html') ?? false
    const target = await resolveUi(site, rawPathname(c.req.url), acceptsHtml)
    if (target.kind === 'not-found') return c.notFound()
    if (target.kind === 'index') {
      return new Response(site.indexHtml, {
        headers: {
          ...UI_HEADERS,
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': site.csp,
        },
      })
    }
    // Only the page runs as the host's origin; any other file opened on its own (an SVG, say) is sandboxed.
    const headers: Record<string, string> = { ...UI_HEADERS, 'Content-Security-Policy': SANDBOX_CSP }
    if (target.sitePath.startsWith('/assets/')) headers['Cache-Control'] = IMMUTABLE
    return new Response(Bun.file(target.path), { headers })
  })
}

/** The path of a request URL exactly as sent, before any decoding or dot-segment resolution. */
function rawPathname(url: string): string {
  const pathStart = url.indexOf('/', url.indexOf('//') + 2)
  return pathStart < 0 ? '/' : (url.slice(pathStart).split(/[?#]/)[0] ?? '/')
}
