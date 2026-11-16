import type { ReactNode } from 'react'

export function EmptyState(props: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
      <div className="mb-1 text-ink-3">{props.icon}</div>
      <h2 className="text-[17px] font-semibold">{props.title}</h2>
      <p className="max-w-sm text-ink-2 leading-relaxed">{props.body}</p>
      {props.action && <div className="mt-3">{props.action}</div>}
    </div>
  )
}
