import { type MailTemplate, renderLinkEmail } from './template'

/** What the email-verification email needs: the single-use link that confirms the address. */
export interface VerifyEmailData {
  url: string
}

/** Sent after sign-up, so the user can confirm they own the address. */
export const verifyEmail: MailTemplate<'verifyEmail', VerifyEmailData> = {
  name: 'verifyEmail',
  render: ({ url }) =>
    renderLinkEmail({
      subject: 'Verify your email address',
      intro: 'Confirm this email address to finish setting up your account.',
      action: 'Verify email address',
      url,
      outro: 'If you did not create an account, you can ignore this email.',
    }),
}
