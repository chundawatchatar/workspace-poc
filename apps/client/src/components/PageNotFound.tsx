import { Link } from '@tanstack/react-router'
import { Centered, linkClass } from './Centered'

/** The page for a path outside every machine. */
export function PageNotFound() {
  return (
    <Centered>
      <p>Page not found.</p>
      <Link to="/" className={`text-xs ${linkClass}`}>
        Back to your machines
      </Link>
    </Centered>
  )
}
