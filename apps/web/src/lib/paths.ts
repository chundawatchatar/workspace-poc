/** Shows a path under the home folder as `~/…`, for display only. */
export function shortPath(path: string, home: string | undefined) {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}
