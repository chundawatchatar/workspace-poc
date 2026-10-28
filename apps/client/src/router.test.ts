import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { saveMachine } from './lib/machines'
import { installMemoryStorage, uninstallMemoryStorage } from './lib/testStorage'
import { createAppRouter } from './router'

/** Loads `path` in a real router and renders it to HTML. */
async function render(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }))
  await router.load()
  return renderToString(createElement(RouterProvider, { router }))
}

const realLocation = globalThis.location
afterAll(() => {
  globalThis.location = realLocation
  uninstallMemoryStorage()
})

beforeAll(() => {
  installMemoryStorage()
  // The page's origin stands in for the cloud server.
  globalThis.location = { origin: 'http://localhost:3220' } as Location
  saveMachine({ id: 'saved-machine', name: 'Laptop', key: 'k1' })
})

describe('client routes', () => {
  test('unknown paths show not found, under a machine inside its page', async () => {
    const underMachine = await render('/m/saved-machine/w/ws1/unknown')
    expect(underMachine).toContain('Page not found.')
    expect(underMachine).toContain('Laptop')

    expect(await render('/nope')).toContain('Page not found.')
  })

  test('known paths render their page, not the not-found view', async () => {
    const home = await render('/')
    expect(home).toContain('Laptop')
    expect(home).not.toContain('Page not found.')

    const workspace = await render('/m/saved-machine/w/ws1')
    expect(workspace).toContain('Connecting to the host')
    expect(workspace).not.toContain('Page not found.')

    expect(await render('/m/other-machine')).toContain('linked in this browser.')
  })
})
