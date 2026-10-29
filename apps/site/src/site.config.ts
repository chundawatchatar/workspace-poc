import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@orch/ui/brand'

// Everything a launch will change lives here: the links and prices. The URLs are placeholders. The name and tagline
// come from `@orch/ui/brand`, which the apps share.

export const SITE = {
  name: PRODUCT_NAME,
  short: 'orch',
  tagline: PRODUCT_TAGLINE,
  description:
    'A free, local-first workspace for terminals and coding agents. Split panes, tabs and real shells that run on your own machine and live in your browser.',
  domain: 'orchestrator.example.com',
  githubUrl: 'https://github.com/your-org/orchestrator',
  installCommand: 'git clone https://github.com/your-org/orchestrator && cd orchestrator && bun install && bun run dev',
  localUrl: 'http://127.0.0.1:3210',
}

export interface Plan {
  id: string
  name: string
  /** Shown as the pane's tab title. */
  tab: string
  price: string
  period: string
  note: string
  features: string[]
  cta: { label: string; href: string }
  featured?: boolean
}

export const ANNUAL_DISCOUNT = '2 months free'

export const PLANS: Plan[] = [
  {
    id: 'local',
    name: 'Local',
    tab: 'local — free',
    price: '$0',
    period: 'forever',
    note: 'Everything that runs on your machine. MIT licensed.',
    features: [
      'Unlimited workspaces, panes and terminals',
      'Sessions that outlive the browser tab',
      'Any CLI agent: Claude Code, Codex, Aider…',
      'Notifications when a terminal needs you',
      'Command palette, shortcuts, 8 themes',
      'Self-host the relay for remote access',
    ],
    cta: { label: 'Install', href: '/docs/getting-started' },
  },
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    tab: 'orchestrator — remote',
    price: '$10',
    period: 'per user / month',
    note: `Or $100 a year (${ANNUAL_DISCOUNT}). Reach every machine from anywhere.`,
    features: [
      'Everything in Local',
      'Hosted relay: no server to run, no ports to open',
      'Every linked machine on one dashboard',
      'Open any workspace from any browser',
      'Revoke a device or rotate a key in one click',
      'Cancel anytime: local work is never affected',
    ],
    cta: { label: 'Set up remote access', href: '/docs/remote-access' },
    featured: true,
  },
]

export interface Faq {
  q: string
  a: string
}

export const FAQ: Faq[] = [
  {
    q: 'Is the local app really free?',
    a: 'Yes. Every feature that runs on your machine is free and open source under the MIT licence. Only the hosted relay for remote access is paid.',
  },
  {
    q: 'Does my code leave my machine?',
    a: 'No. Shells, files and the layout live on your machine. The relay only forwards terminal traffic for sessions you open remotely, and stores none of it.',
  },
  {
    q: 'Which agents does it support?',
    a: 'Any agent that runs in a terminal. Orchestrator builds no agent of its own: run Claude Code, Codex, Aider or a plain shell side by side.',
  },
  {
    q: 'What happens if I close the browser?',
    a: 'Nothing stops. Terminals run in a daemon on your machine, so closing the tab, reloading or restarting the host leaves shells and agents running.',
  },
  {
    q: 'Which platforms are supported?',
    a: 'macOS and Linux today, used from any current browser. Windows support is planned.',
  },
  {
    q: 'What if I cancel Orchestrator?',
    a: 'Remote access stops. Your machines, workspaces and sessions keep working locally exactly as before.',
  },
]

/** The page's sections, listed in the sidebar like workspaces in the app. */
export const SECTIONS = [
  { id: 'top', name: 'orchestrator', branch: 'main', changes: 0 },
  { id: 'problem', name: 'problem', branch: 'why', changes: 4 },
  { id: 'how', name: 'how-it-works', branch: 'arch', changes: 3 },
  { id: 'agents', name: 'agents', branch: 'byo-agent', changes: 2 },
  { id: 'remote', name: 'remote', branch: 'tunnel', changes: 1 },
  { id: 'pricing', name: 'pricing', branch: 'plans', changes: 2 },
  { id: 'faq', name: 'faq', branch: 'answers', changes: 6 },
]
