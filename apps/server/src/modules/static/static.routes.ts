import { Hono } from 'hono'
import { resolveStatic, type StaticSite } from './static.service'

/** What the static routes need from the server. Null or missing means there is no built client to serve. */
export interface StaticRoutesDeps {
  site?: StaticSite | null
}

const IMMUTABLE = 'public, max-age=31536000, immutable'

/**
 * Serves the built client: its files byte for byte, and `index.html` for the
 * client's own routes. Mounted last, so the relay routes always win. Anything
 * else, including every method but GET and HEAD, gets 404.
 */
export function createStaticRoutes({ site }: StaticRoutesDeps) {
  return new Hono().all('*', async (c) => {
    if (!site || (c.req.method !== 'GET' && c.req.method !== 'HEAD')) return c.notFound()
    const acceptsHtml = c.req.header('accept')?.includes('text/html') ?? false
    const target = await resolveStatic(site, rawPathname(c.req.url), acceptsHtml)
    if (target.kind === 'not-found') return c.notFound()
    if (target.kind === 'index') {
      return new Response(site.indexHtml, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': site.csp,
        },
      })
    }
    const file = Bun.file(target.path)
    const relative = target.path.slice(site.root.length)
    return new Response(file, relative.startsWith('/assets/') ? { headers: { 'Cache-Control': IMMUTABLE } } : {})
  })
}

/** The path of a request URL exactly as sent, before any decoding or dot-segment resolution. */
function rawPathname(url: string): string {
  const pathStart = url.indexOf('/', url.indexOf('//') + 2)
  return pathStart < 0 ? '/' : (url.slice(pathStart).split(/[?#]/)[0] ?? '/')
}
