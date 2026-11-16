import { useId, type InputHTMLAttributes, type Ref } from 'react'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string
  hint?: string
  error?: string
  ref?: Ref<HTMLInputElement>
}

export function TextField({ label, hint, error, className = '', ref, ...rest }: Props) {
  const id = useId()
  const describedBy = error || hint ? `${id}-note` : undefined
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-[13px] font-semibold">
        {label}
      </label>
      <input
        id={id}
        ref={ref}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`h-7 rounded-md border bg-field px-2 text-[13px] text-ink outline-none select-text placeholder:text-ink-3 focus:border-accent focus:ring-1 focus:ring-accent ${
          error ? 'border-danger ring-1 ring-danger' : 'border-sep'
        }`}
        {...rest}
      />
      {(error || hint) && (
        <p id={describedBy} className={`text-[11px] leading-snug ${error ? 'text-danger' : 'text-ink-2'}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  )
}
