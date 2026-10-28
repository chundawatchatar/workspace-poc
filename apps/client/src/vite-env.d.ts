/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The cloud server's URL, set at build time. Without it, the client uses the origin it is served from. */
  readonly VITE_SERVER_URL?: string
}
