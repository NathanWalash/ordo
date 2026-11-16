import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary'
  icon?: ReactNode
}

/** macOS-style push button. Primary is for the one main action in a view. */
export function Button({ variant = 'secondary', icon, className = '', children, ...rest }: Props) {
  const look =
    variant === 'primary'
      ? 'bg-accent text-white enabled:hover:brightness-110 enabled:active:brightness-95'
      : 'bg-field text-ink border border-sep shadow-[0_1px_1px_rgb(0_0_0/0.06)] enabled:hover:bg-hover'
  return (
    <button
      type="button"
      className={`no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium disabled:opacity-50 ${look} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
