import { type MailTemplate, renderLinkEmail } from './template'

/** What the password-reset email needs: the single-use link that lets the user choose a new password. */
export interface ResetPasswordData {
  url: string
}

/** Sent when someone asks to reset the password of an account. */
export const resetPassword: MailTemplate<'resetPassword', ResetPasswordData> = {
  name: 'resetPassword',
  render: ({ url }) =>
    renderLinkEmail({
      subject: 'Reset your password',
      intro: 'Someone asked to reset the password for your account.',
      action: 'Choose a new password',
      url,
      outro: 'If it was not you, you can ignore this email; your password stays the same.',
    }),
}
