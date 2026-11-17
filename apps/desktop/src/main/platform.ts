/** Mica needs Windows 11, which reports itself as Windows 10.0 build 22000 or later. */
export function supportsMica(platform: NodeJS.Platform, systemVersion: string): boolean {
  if (platform !== 'win32') return false
  const build = Number(systemVersion.split('.')[2])
  return Number.isFinite(build) && build >= 22000
}
