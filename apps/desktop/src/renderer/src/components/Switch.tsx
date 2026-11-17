interface Props {
  /** Accessible name, e.g. "Unsubscribe from Shop". */
  label: string
  checked: boolean
  disabled?: boolean
  /** `mini` for dense rows such as the review sheet; `regular` for Settings. */
  size?: 'regular' | 'mini'
  onChange: (checked: boolean) => void
}

const SIZES = {
  regular: { track: 'h-[22px] w-[38px]', knob: 'size-[18px]', on: 'translate-x-4' },
  mini: { track: 'h-[18px] w-8', knob: 'size-[14px]', on: 'translate-x-[14px]' },
}

/** macOS-style toggle. */
export function Switch({ label, checked, disabled, size = 'regular', onChange }: Props) {
  const s = SIZES[size]
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`no-drag relative ${s.track} shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        checked ? 'bg-accent' : 'bg-selected shadow-[inset_0_0_0_1px_var(--sep)]'
      }`}
    >
      <span
        className={`absolute top-[2px] left-[2px] ${s.knob} rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3)] transition-transform ${
          checked ? s.on : ''
        }`}
      />
    </button>
  )
}
