import { Toast } from '@orch/ui'
import { useSyncExternalStore } from 'react'
import { getToast, subscribeToast } from '../lib/toast'

/** Shows the current toast, if any. Mounted once at the root. */
export function Toaster() {
  const toast = useSyncExternalStore(subscribeToast, getToast, () => null)
  // A new key per toast replays the entrance when one replaces another.
  return toast && <Toast key={toast.id} message={toast.message} kind={toast.kind} />
}
