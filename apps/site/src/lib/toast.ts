// Toasts from any island. SiteChrome shows them with the app's Toast.

export interface ToastMessage {
  message: string
  kind: 'info' | 'error'
}

export function toast(message: string, kind: ToastMessage['kind'] = 'info') {
  window.dispatchEvent(new CustomEvent<ToastMessage>('orch:toast', { detail: { message, kind } }))
}

export async function copyText(text: string, done = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text)
    toast(done)
  } catch {
    toast('Copy failed: select the text instead', 'error')
  }
}
