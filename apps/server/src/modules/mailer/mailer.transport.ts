import { createTransport } from 'nodemailer'
import { parseConnectionUrl } from 'nodemailer/lib/shared'

/** One email, complete, as the mailer hands it to a transport. */
export interface MailMessage {
  from: string
  to: string
  subject: string
  text: string
  html: string
}

/** Where the mailer sends email. `send` resolves once the message is accepted, and rejects otherwise. */
export interface MailTransport {
  send(message: MailMessage): Promise<void>
}

/** How long an SMTP send may wait, in milliseconds, at each stage. */
export interface SmtpTimeouts {
  /** For the TCP connection to open. */
  connectionMs: number
  /** For the server's greeting once connected. */
  greetingMs: number
  /** For any reply while the connection is idle. */
  socketMs: number
}

const DEFAULT_TIMEOUTS: SmtpTimeouts = { connectionMs: 10_000, greetingMs: 10_000, socketMs: 30_000 }

/**
 * Sends email over SMTP to `smtpUrl` (`smtp://` or `smtps://`, optionally
 * with `user:pass@`), one connection per message. A hung server fails the
 * send after `timeouts` instead of stalling it. Nodemailer's logger and debug
 * output stay off, even if the URL asks for them, since they print the SMTP
 * conversation, message included.
 */
export function createSmtpTransport(smtpUrl: string, timeouts: SmtpTimeouts = DEFAULT_TIMEOUTS): MailTransport {
  const transporter = createTransport({
    ...parseConnectionUrl(smtpUrl),
    connectionTimeout: timeouts.connectionMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    logger: false,
    debug: false,
  })
  return {
    async send(message) {
      await transporter.sendMail(message)
    },
  }
}
