import { join } from 'node:path'

/** The drizzle-kit migrations folder, found from this file so it works whatever the working directory is. */
export const migrationsFolder = join(import.meta.dir, '../migrations')
