import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { user } from './user'

/**
 * Short-lived, single-use keys a signed-in user creates to link a machine
 * from the machine itself. Only the key's SHA-256 hash is stored, never the
 * key. A machine that sends the key asks to be linked, and the row records
 * that request until the owner accepts or rejects it, which uses the key up.
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
    /** When the owner accepted or rejected the machine's request; null means the key is still unused. */
    usedAt: timestamp('used_at'),
    /**
     * The id of the machine that asked to be linked with the key, from its
     * tunnel's proof. Null until one asks; once set, no other machine can.
     */
    requestMachineId: text('request_machine_id'),
    /** The name the machine asked to be linked under. Null until one asks. */
    requestName: text('request_name'),
    /** When the machine last asked. Null until one asks. */
    requestedAt: timestamp('requested_at'),
  },
  (table) => [
    uniqueIndex('machine_enrollments_keyHash_idx').on(table.keyHash),
    index('machine_enrollments_userId_idx').on(table.userId),
  ],
)
