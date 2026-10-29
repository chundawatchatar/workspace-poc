import { loadRootEnv } from '@orch/shared/env'
import { defineConfig } from 'drizzle-kit'

loadRootEnv()

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schemas/index.ts',
  out: './migrations',
  // `generate` only diffs the schema against `migrations/`, so it works without a database.
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
})
