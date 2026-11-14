/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The host's address, from `HOST_HOST` and `HOST_PORT` when `vite dev` started. Unset in a build, which talks to the
   * page's own origin.
   */
  readonly VITE_HOST_URL?: string
}
