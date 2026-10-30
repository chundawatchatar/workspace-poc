## Account follow-ups

Small leftovers from the accounts sprint (jobs 033 and 034). Independent of each other and of the agent sprint.

- [x] Docs: bring `docs/accounts.md` in line with the account page from job 033: it still says the client has no page for listing or revoking sessions (around line 144) and calls session tokens an "Open question" (around lines 155-157), which `docs/architecture.md` now marks "Resolved for now"; describe the `/account` page, its fresh-sign-in rule and where tokens go, matching `docs/architecture.md` → 035-accounts-docs-account-page
- [x] Client: accessibility polish on the account page from the job 033 reviews: keep focus on Confirm when "Sign out from all devices" asks to confirm and return it to the button on Cancel, announce the "password changed" message reliably (a live region present before the message), make the account menu's sign-out error dismissible and keep it from clipping or overlapping in the machine page's narrow sidebar header, and show the "Last active is approximate" note as visible text or an accessible description instead of only a `title` → 036-account-page-a11y
