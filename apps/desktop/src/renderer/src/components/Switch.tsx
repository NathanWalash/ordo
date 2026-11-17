interface Props {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}

/** macOS-style toggle. */
export function Switch({ label, checked, disabled, onChange }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`no-drag relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        checked ? 'bg-accent' : 'bg-selected'
      }`}
    >
      <span
        className={`absolute top-[2px] left-[2px] size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3)] transition-transform ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </button>
  )
}
