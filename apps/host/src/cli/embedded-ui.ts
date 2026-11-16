// The executable's generated entry (written by `scripts/package-host.ts`) calls `embedUi` with the files compiled into
// it, then imports `main.ts`. Run from source nothing calls it, so there is no embedded site. It is module state
// because the files are fixed when the executable is built and handed in before any other module loads.

let embedded: Readonly<Record<string, string>> | null = null

/** Records the built UI compiled into the executable: each file's embedded path, by its URL path (`/index.html`). */
export function embedUi(files: Readonly<Record<string, string>>) {
  embedded = Object.freeze({ ...files })
}

/** The files `embedUi` recorded. Null means the executable has no UI compiled in, as when run from source. */
export function embeddedUi(): Readonly<Record<string, string>> | null {
  return embedded
}
