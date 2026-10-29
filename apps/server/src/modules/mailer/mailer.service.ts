import type { MailTransport } from './mailer.transport'
import { renderTemplate, type TemplateData, type TemplateName } from './templates'

/** Sends the server's emails. Every email goes through here, rendered from one of the templates. */
export interface Mailer {
  /**
   * Renders `template` with `data` and sends it to `to`. Resolves once the
   * transport accepts the message; otherwise rejects with a `MailSendError`.
   */
  send<Name extends TemplateName>(to: string, template: Name, data: TemplateData<Name>): Promise<void>
}

/** What the mailer needs: where to send, and the `From` header (`MAIL_FROM`). */
export interface MailerDeps {
  transport: MailTransport
  from: string
}

/**
 * Thrown by `Mailer.send`. The message holds only the template name and an
 * error code, never the recipient, the link or the transport's own error text,
 * which can echo parts of the email.
 */
export class MailSendError extends Error {
  override name = 'MailSendError'

  constructor(
    readonly template: TemplateName,
    /** A code such as `ECONNECTION` or `ETIMEDOUT`, or `UNKNOWN` when the error had none. */
    readonly code: string,
  ) {
    super(`The ${template} email was not sent (${code})`)
  }
}

/**
 * Builds the mailer. It logs one line per send, with the template name and
 * the outcome, and never the recipient, the subject, the body or the link.
 */
export function createMailer({ transport, from }: MailerDeps): Mailer {
  return {
    async send(to, template, data) {
      try {
        await transport.send({ from, to, ...renderTemplate(template, data) })
      } catch (error) {
        const code = errorCode(error) ?? 'UNKNOWN'
        console.error(`mail ${template}: failed (${code})`)
        throw new MailSendError(template, code)
      }
      console.log(`mail ${template}: sent`)
    },
  }
}

/** An error code such as `ECONNECTION`, or undefined when there is none. Only the code is kept from an error. */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : undefined
}
