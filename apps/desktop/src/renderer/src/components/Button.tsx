import type { ComponentPropsWithRef, ReactNode } from 'react'

interface Props extends ComponentPropsWithRef<'button'> {
  /** Primary is the one main action in a view; destructive is the button that deletes. */
  variant?: 'primary' | 'secondary' | 'destructive'
  icon?: ReactNode
}

const LOOKS = {
  primary: 'bg-accent text-white enabled:hover:brightness-110 enabled:active:brightness-95',
  destructive: 'bg-danger-strong text-white enabled:hover:brightness-110 enabled:active:brightness-95',
  secondary: 'bg-field text-ink border border-sep shadow-[0_1px_1px_rgb(0_0_0/0.06)] enabled:hover:bg-hover',
}

/** macOS-style push button. */
export function Button({ variant = 'secondary', icon, className = '', children, ...rest }: Props) {
  return (
    <button
      type="button"
      className={`no-drag inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium disabled:opacity-50 aria-disabled:opacity-50 ${LOOKS[variant]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
