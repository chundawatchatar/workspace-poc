import { afterEach, expect } from 'bun:test'
import { format } from 'node:util'
import * as matchers from '@testing-library/jest-dom/matchers'
import { cleanup } from '@testing-library/react'

// The React Testing Library setup every browser workspace preloads after its own happy-dom (see its `bunfig.toml`).

expect.extend(matchers)

// Collected here and thrown after the test, so a React warning (`act(…)`, a missing key, a bad prop) fails the test
// that caused it, with the message in the failure.
const logged: string[] = []
for (const level of ['error', 'warn'] as const) {
  console[level] = (...args: unknown[]) => {
    logged.push(`console.${level}: ${format(...args)}`)
  }
}

afterEach(() => {
  cleanup()
  const messages = logged.splice(0)
  if (messages.length > 0) throw new Error(`The test logged:\n${messages.join('\n')}`)
})
