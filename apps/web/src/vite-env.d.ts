/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The host's address, from `HOST_HOST` and `HOST_PORT` when the app was started or built. */
  readonly VITE_HOST_URL: string
}
