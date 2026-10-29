import { loadRootEnv } from '@orch/shared/env'

// Imported first by `index.ts`, so the root `.env` is loaded before any module reads `process.env`.
loadRootEnv()
