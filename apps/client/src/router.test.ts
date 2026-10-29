import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { useQueryClient } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { saveMachine } from './lib/machines'
import { installMemoryStorage, uninstallMemoryStorage } from './lib/testStorage'

// Vite turns `?url` imports into the asset's URL; Bun would hand the root route the stylesheet's module instead.
mock.module('./styles.css?url', () => ({ default: '/styles.css' }))
const { getRouter } = await import('./router')

/** Loads `path` in the router over the generated route tree and renders it to HTML. */
async function render(path: string, router = getRouter(createMemoryHistory({ initialEntries: [path] }))) {
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

  test('pages share the root query client', async () => {
    const router = getRouter(createMemoryHistory({ initialEntries: ['/'] }))
    const home = router.routesById['/']
    const page = home.options.component
    // Stands in for a page that uses Query.
    home.options.component = function QueryProbe() {
      return useQueryClient() === router.options.context.queryClient ? 'shared query client' : 'another query client'
    }
    try {
      expect(await render('/', router)).toContain('shared query client')
    } finally {
      home.options.component = page
    }
  })
})
