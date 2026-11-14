import { realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { API_PREFIX, WS_PREFIX } from '@orch/shared'

// A copy of the cloud server's `static.service.ts`, without its relay paths. It stays a copy so this job leaves
// `apps/server` untouched; sharing it means moving the pure helpers to a server-only `@orch/shared` subpath.

/** The built local UI the host serves, read once at start-up. */
export interface UiSite {
  /** The real path of the folder, symlinks resolved. */
  root: string
  /** The bytes of `index.html` as they were at start-up, so they always match `csp`. */
  indexHtml: Uint8Array<ArrayBuffer>
  /** The `Content-Security-Policy` for `index.html`. */
  csp: string
}

/** What a UI request resolves to: a file inside the folder, the page, or nothing. */
export type UiTarget = { kind: 'file'; path: string } | { kind: 'index' } | { kind: 'not-found' }

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

/**
 * The `Content-Security-Policy` for an `index.html`, allowing exactly its inline scripts. `connect-src 'self'` also
 * covers the page's same-origin `ws:` sockets. Styles allow inline, since xterm and React set them.
 */
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

/** Reads the UI folder at start-up. Null means it has no readable `index.html`, so there is no UI to serve. */
export async function loadUiSite(dir: string): Promise<UiSite | null> {
  try {
    const root = await realpath(dir)
    const indexHtml = new Uint8Array(await Bun.file(join(root, 'index.html')).arrayBuffer())
    return { root, indexHtml, csp: buildCsp(new TextDecoder().decode(indexHtml)) }
  } catch {
    return null
  }
}

/** True for the API's and the sockets' paths, which the UI never answers, not even with the page. */
export function isApiPath(pathname: string): boolean {
  return [API_PREFIX, WS_PREFIX].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * Resolves a request path against the site. A file inside the folder is
 * served as is. A path that names no file falls back to the page when the
 * browser asks for HTML, for the UI's own routes (`/w/<id>`). Dot segments,
 * dotfiles, encoded slashes and paths that leave the folder through a symlink
 * resolve to nothing, and so does anything under the API or socket prefixes.
 */
export async function resolveUi(site: UiSite, rawPath: string, acceptsHtml: boolean): Promise<UiTarget> {
  const notFound: UiTarget = { kind: 'not-found' }
  if (isApiPath(rawPath)) return notFound
  const segments = decodeSegments(rawPath)
  if (!segments) return notFound
  // Checked again once decoded, so `/%61pi/…` can't reach the page either.
  if (isApiPath(`/${segments.join('/')}`)) return notFound
  if (segments.length === 0 || (segments.length === 1 && segments[0] === 'index.html')) return { kind: 'index' }

  try {
    const path = await realpath(join(site.root, ...segments))
    // A symlink out of the folder is refused outright, not answered with the page.
    if (!path.startsWith(site.root + sep)) return notFound
    if ((await stat(path)).isFile()) return { kind: 'file', path }
  } catch {
    // No such file.
  }
  return acceptsHtml ? { kind: 'index' } : notFound
}

/** The decoded segments of a URL path, ignoring empty ones. Null means a segment is unsafe to join to a folder. */
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
