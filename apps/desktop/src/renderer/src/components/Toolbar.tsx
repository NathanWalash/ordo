import type { AppInfo } from '@ordo/shared'

export function Toolbar({ title, platform }: { title: string; platform?: AppInfo['platform'] }) {
  // On Windows the min/max/close overlay sits top-right; keep content clear of it.
  const right = platform === 'win32' ? 'pr-[140px]' : 'pr-4'
  return (
    <header className={`drag flex h-[52px] shrink-0 items-center border-b border-sep pl-5 ${right}`}>
      <h1 className="text-[15px] font-semibold">{title}</h1>
    </header>
  )
}
