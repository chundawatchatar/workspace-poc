import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { user } from './user'

/**
 * Short-lived, single-use keys a signed-in user creates to link a machine
 * from the machine itself. Only the key's SHA-256 hash is stored, never the
 * key.
 */
export const machineEnrollments = pgTable(
  'machine_enrollments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The key's SHA-256 hash, as lowercase hex. */
    keyHash: text('key_hash').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    /** When a machine redeemed the key; null means it is still unused. */
    usedAt: timestamp('used_at'),
  },
  (table) => [
    uniqueIndex('machine_enrollments_keyHash_idx').on(table.keyHash),
    index('machine_enrollments_userId_idx').on(table.userId),
  ],
)
