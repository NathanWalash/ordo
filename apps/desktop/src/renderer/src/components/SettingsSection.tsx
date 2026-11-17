import type { ReactNode } from 'react'

/** A titled group of settings rows, macOS System Settings style. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `settings-${title.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <section aria-labelledby={id} className="mb-8">
      <h2 id={id} className="mb-2 px-1 text-[13px] font-semibold text-ink-2">
        {title}
      </h2>
      <div className="overflow-hidden rounded-xl border border-sep">{children}</div>
    </section>
  )
}

export function Row({ label, detail, control }: { label: string; detail?: ReactNode; control?: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-4 border-b border-sep px-4 py-2.5 last:border-b-0">
      <div className="flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        {detail && <div className="text-[12px] leading-snug text-ink-2">{detail}</div>}
      </div>
      {control}
    </div>
  )
}
