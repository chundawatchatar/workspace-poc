import '../src/env'
import { createDomain } from '@orch/domain'
import { loadServerConfig, ServerConfigError } from '../src/lib/config'
import { checkDatabase, databaseLocation } from '../src/lib/database'
import { revokeUserSessions } from '../src/modules/auth/auth.sessions'

// Signs one user out everywhere by deleting all their sessions, for an operator handling a compromised account.
// Each session is refused on its next request. Uses `DATABASE_URL` from the root `.env`. Usage, from the repo root:
//   bun run --filter @orch/server sessions:revoke-user <email>
//   bun apps/server/scripts/revoke-user-sessions.ts <email>
// It never prints the email, a session token or `DATABASE_URL`.

const email = process.argv[2]
if (!email?.trim()) {
  console.error('usage: bun apps/server/scripts/revoke-user-sessions.ts <email>')
  process.exit(1)
}

let config: ReturnType<typeof loadServerConfig>
try {
  config = loadServerConfig(process.env)
} catch (error) {
  if (!(error instanceof ServerConfigError)) throw error
  console.error(error.message)
  process.exit(1)
}
if (!config.accounts) {
  console.error('DATABASE_URL is not set, so accounts are off and there are no sessions to revoke.')
  process.exit(1)
}

const domain = createDomain(config.accounts.databaseUrl)
let exitCode = 0
try {
  const db = domain.skipAuthorization('operator: revoke every session of one user')
  const problem = await checkDatabase(db, databaseLocation(config.accounts.databaseUrl))
  if (problem) {
    console.error(problem)
    exitCode = 1
  } else {
    const { found, revoked } = await revokeUserSessions(db, email)
    if (found) {
      console.log(`revoked ${revoked} session(s)`)
    } else {
      console.error('no user with that email')
      exitCode = 1
    }
  }
} finally {
  await domain.close()
}
process.exit(exitCode)
