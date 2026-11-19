import type { AgentMark } from '../types'

/** The published pi mark, with its original shape and source information. */
export const icon = {
  viewBox: '0 0 560 560',
  paths: [
    { d: 'M420 280H280V140H0V0H420V280Z' },
    { d: 'M560 560H420V280H560V560Z' },
    { d: 'M140 560H0V140H140V280H280V420H140V560Z' },
  ],
  colors: 'currentColor',
  inset: 1,
  source: 'https://pi.dev/favicon.svg',
  terms: 'https://pi.dev/press-kit',
  termsSummary:
    'Press kit badge, a "square mark for favicons and compact badges", on a site marked MIT License; one colour, dark or light.',
} satisfies AgentMark
