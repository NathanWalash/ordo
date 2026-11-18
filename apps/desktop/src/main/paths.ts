/**
 * Checks for paths that came from outside Ordo (a command line, an agent, a model), made before
 * any file-system call. Pure: no disk access.
 */

/**
 * UNC and device paths (`\\server\share`, `//server/share`, `\\?\…`, `\\.\…`, either slash).
 * Touching one can reach the network (on Windows, sending the user's credentials over SMB) or a
 * device, so Ordo never opens them.
 */
export function isUncOrDevicePath(path: string): boolean {
  return /^[\\/]{2}/.test(path.trim())
}

/** An absolute path on this computer: `/…` on macOS and Linux, `C:\…` or `C:/…` on Windows. */
export function isAbsoluteLocalPath(path: string): boolean {
  if (isUncOrDevicePath(path)) return false
  return /^\/(?!\/)/.test(path) || /^[A-Za-z]:[\\/]/.test(path)
}

/** Why a path given to Ordo can't be used, or null when it can. */
export function pathProblem(path: string, options: { requireAbsolute: boolean }): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) return 'That path has control characters in it.'
  if (isUncOrDevicePath(path)) return 'Ordo only opens files on this computer, not network or device paths.'
  if (options.requireAbsolute && !isAbsoluteLocalPath(path))
    return 'Give the full path to the file, like /Users/you/Downloads/statement.csv.'
  return null
}
