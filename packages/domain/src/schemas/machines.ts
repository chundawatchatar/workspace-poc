import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { user } from './user'

/**
 * The machines linked to each account, by the id the relay derives from the
 * machine's secret. Only ids and names live here, never access keys.
 */
export const machines = pgTable(
  'machines',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    machineId: text('machine_id').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    /** When the machine was last linked or opened through a connect link. */
    lastOpenedAt: timestamp('last_opened_at').notNull(),
  },
  (table) => [
    uniqueIndex('machines_userId_machineId_idx').on(table.userId, table.machineId),
    index('machines_userId_idx').on(table.userId),
  ],
)
