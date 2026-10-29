import '../src/env'
import { loadServerConfig, ServerConfigError } from '../src/lib/config'
import { emailLinkUrl } from '../src/modules/auth/auth.service'
import { createMailer, MailSendError } from '../src/modules/mailer/mailer.service'
import { createSmtpTransport } from '../src/modules/mailer/mailer.transport'

// Sends one `verifyEmail` message with a dummy link through `SMTP_URL` from the root `.env`, to check the mailer
// against Mailpit (`bun run db:up`, then http://127.0.0.1:8025). Usage: `bun apps/server/scripts/send-test-mail.ts <to>`.

const to = process.argv[2]
if (!to) {
  console.error('usage: bun apps/server/scripts/send-test-mail.ts <to>')
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
  console.error('DATABASE_URL is not set, so accounts and the mailer are off. Copy .env.example to .env first.')
  process.exit(1)
}

const mailer = createMailer({
  transport: createSmtpTransport(config.accounts.smtpUrl),
  from: config.accounts.mailFrom,
})
try {
  await mailer.send(to, 'verifyEmail', {
    url: emailLinkUrl(config.accounts.betterAuthUrl, 'verify-email', 'test-only'),
  })
} catch (error) {
  if (!(error instanceof MailSendError)) throw error
  process.exit(1)
}
