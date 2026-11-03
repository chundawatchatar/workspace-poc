import type { expect } from 'bun:test'
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

// Types the jest-dom matchers that `react.ts` adds to `expect`. A workspace gets them by listing `@orch/test-setup`
// in its tsconfig's `types`.
declare module 'bun:test' {
  interface Matchers<T> extends TestingLibraryMatchers<ReturnType<typeof expect.stringContaining>, T> {}
}
