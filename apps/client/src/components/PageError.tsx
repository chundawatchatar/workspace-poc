import { Button } from '@orch/ui'
import { useQueryClient } from '@tanstack/react-query'
import { type ErrorComponentProps, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { refetchSession } from '../lib/auth'
import { Centered } from './Centered'

/**
 * The page for a route that failed to load, such as when the session can't be read. It never shows the error, which
 * may name a status or carry the server's answer. Retry reads the session again and, once it answers, reruns the
 * route; while the session still can't be read, the page stays.
 */
export function PageError({ reset }: ErrorComponentProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState(false)

  const retry = async () => {
    setPending(true)
    // A fresh read, even when the cached one failed. Rerunning the route only after it answers keeps the page from
    // flashing what's under it, and a second failure from reading the session twice.
    const read = await refetchSession(queryClient).then(
      () => true,
      () => false,
    )
    if (!read) {
      setPending(false)
      return
    }
    await router.invalidate()
    reset()
  }

  return (
    <Centered>
      <p className="text-ink">Something went wrong.</p>
      <p className="text-xs">This page couldn't load. Try again in a moment.</p>
      <Button variant="secondary" pending={pending} onClick={() => void retry()}>
        Retry
      </Button>
    </Centered>
  )
}
