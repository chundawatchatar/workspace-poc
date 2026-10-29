import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

/**
 * The Better Auth config the CLI reads to generate the tables in `src/schemas/`. It is never imported by the
 * package; see `README.md` for the command.
 */
export const auth = betterAuth({
  database: drizzleAdapter({}, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
})
