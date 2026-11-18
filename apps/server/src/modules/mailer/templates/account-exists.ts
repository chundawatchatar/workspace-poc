import { type MailTemplate, renderLinksEmail } from './template'

/** What the account-exists email needs: the client's sign-in page and its forgot-password page. */
export interface AccountExistsData {
  signInUrl: string
  forgotPasswordUrl: string
}

/**
 * Sent instead of a sign-up code when the address already has an account, so
 * the answer to asking for a code is the same whether or not it has one.
 */
export const accountExists: MailTemplate<'accountExists', AccountExistsData> = {
  name: 'accountExists',
  render: ({ signInUrl, forgotPasswordUrl }) =>
    renderLinksEmail({
      subject: 'You already have an account',
      intro: 'Someone asked for a sign-up code for this email address, but it already has an account.',
      links: [
        { action: 'Sign in', url: signInUrl },
        { action: 'Reset your password', url: forgotPasswordUrl },
      ],
      outro: 'If it was not you, you can ignore this email; your account has not changed.',
    }),
}
