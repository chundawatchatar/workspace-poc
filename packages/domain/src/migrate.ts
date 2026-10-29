import { loadRootEnv } from '@orch/shared/env'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDb } from './db'
import { migrationsFolder } from './migrations'

// Applies every pending migration in `migrations/` to the database at `DATABASE_URL`. Run with `bun run db:migrate`.

loadRootEnv()
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env at the repo root, or set it in the environment.')
  process.exit(1)
}

const db = createDb(url)
try {
  await migrate(db, { migrationsFolder })
  console.log('Migrations applied.')
} catch (error) {
  console.error('Migration failed:', error)
  process.exitCode = 1
} finally {
  await db.$client.close()
}
