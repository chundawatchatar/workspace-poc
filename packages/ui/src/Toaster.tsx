import { useSyncExternalStore } from 'react'
import { getToast, subscribeToast } from './lib/toast'
import { Toast } from './Toast'

/** Shows the toast from `showToast`, if any. Mount it once at each app's root, outside any page component. */
export function Toaster() {
  const toast = useSyncExternalStore(subscribeToast, getToast, () => null)
  // A new key per toast replays the entrance when one replaces another.
  return toast && <Toast key={toast.id} message={toast.message} kind={toast.kind} placement={toast.placement} />
}
