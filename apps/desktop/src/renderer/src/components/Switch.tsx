interface Props {
  /** Accessible name, e.g. "Unsubscribe from Shop". */
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}

/** macOS-style mini switch. */
export function Switch({ label, checked, disabled, onChange }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        checked ? 'bg-accent' : 'bg-selected shadow-[inset_0_0_0_1px_var(--sep)]'
      }`}
    >
      <span
        className={`absolute top-[2px] left-[2px] size-[14px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.3)] transition-transform ${
          checked ? 'translate-x-[14px]' : ''
        }`}
      />
    </button>
  )
}
