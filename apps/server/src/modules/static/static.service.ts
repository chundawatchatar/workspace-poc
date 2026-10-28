import { realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { API_PREFIX, TUNNEL_PATH, WS_PREFIX } from '@orch/shared'

/** The built client the server serves, read once at startup. */
export interface StaticSite {
  /** The real path of the static dir, symlinks resolved. */
  root: string
  /** The bytes of `index.html` as they were at startup, so they always match `csp`. */
  indexHtml: Uint8Array
  /** The `Content-Security-Policy` for `index.html`. */
  csp: string
}

/** What a static request resolves to: a file inside the dir, the page, or nothing. */
export type StaticTarget = { kind: 'file'; path: string } | { kind: 'index' } | { kind: 'not-found' }

const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
const SRC_ATTRIBUTE = /\bsrc\s*=/i

/** The CSP source of each inline script in `html`, as `'sha256-…'`, in document order. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = []
  for (const [, attributes = '', body = ''] of html.matchAll(INLINE_SCRIPT)) {
    if (SRC_ATTRIBUTE.test(attributes)) continue
    hashes.push(`'sha256-${new Bun.CryptoHasher('sha256').update(body).digest('base64')}'`)
  }
  return hashes
}

/** The `Content-Security-Policy` for an `index.html`, allowing exactly its inline scripts. */
export function buildCsp(html: string): string {
  return [
    "default-src 'self'",
    `script-src ${["'self'", ...inlineScriptHashes(html)].join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/** Reads the static dir at startup. Null means it has no `index.html`, so there is no client to serve. */
export async function loadStaticSite(dir: string): Promise<StaticSite | null> {
  try {
    const root = await realpath(dir)
    const indexHtml = new Uint8Array(await Bun.file(join(root, 'index.html')).arrayBuffer())
    return { root, indexHtml, csp: buildCsp(new TextDecoder().decode(indexHtml)) }
  } catch {
    return null
  }
}

/**
 * True for the paths the relay owns: `TUNNEL_PATH` and everything under a
 * machine's `/api/` and `/ws/`. The client's own `/m/<id>` pages are not.
 */
export function isRelayPath(pathname: string): boolean {
  if (pathname === TUNNEL_PATH) return true
  const match = /^\/m\/[^/]+(\/[^/]*)/.exec(pathname)
  return match?.[1] === API_PREFIX || match?.[1] === WS_PREFIX
}

/**
 * Resolves a request path against the site. A file inside the dir is served
 * as is. A path that names no file falls back to the page when the browser
 * asks for HTML, for the client's own routes. Dot segments, dotfiles, encoded
 * slashes and paths that leave the dir through a symlink resolve to nothing.
 */
export async function resolveStatic(site: StaticSite, rawPath: string, acceptsHtml: boolean): Promise<StaticTarget> {
  const notFound: StaticTarget = { kind: 'not-found' }
  if (isRelayPath(rawPath)) return notFound
  const segments = decodeSegments(rawPath)
  if (!segments) return notFound
  if (segments.length === 0 || (segments.length === 1 && segments[0] === 'index.html')) return { kind: 'index' }

  try {
    const path = await realpath(join(site.root, ...segments))
    // A symlink out of the dir is refused outright, not answered with the page.
    if (!path.startsWith(site.root + sep)) return notFound
    if ((await stat(path)).isFile()) return { kind: 'file', path }
  } catch {
    // No such file.
  }
  return acceptsHtml ? { kind: 'index' } : notFound
}

/** The decoded segments of a URL path, ignoring empty ones. Null means a segment is unsafe to join to a dir. */
function decodeSegments(rawPath: string): string[] | null {
  const segments: string[] = []
  for (const raw of rawPath.split('/')) {
    if (raw === '') continue
    let segment: string
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (segment.startsWith('.') || /[/\\\0]/.test(segment)) return null
    segments.push(segment)
  }
  return segments
}
