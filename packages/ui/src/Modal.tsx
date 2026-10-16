import type { ReactNode } from 'react'

export function Modal(props: { title: string; children: ReactNode; width?: string; onClose: () => void }) {
  return (
    <div
      className="anim-backdrop fixed inset-0 z-50 flex items-start justify-center bg-black/55 pt-[14vh]"
      onPointerDown={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <div
        role="dialog"
        aria-label={props.title}
        className={`anim-dialog ${props.width ?? 'w-[440px]'} rounded-lg border border-line bg-sidebar shadow-2xl`}
      >
        <div className="border-b border-line px-4 py-3 text-sm font-semibold">{props.title}</div>
        <div className="p-4">{props.children}</div>
      </div>
    </div>
  )
}
