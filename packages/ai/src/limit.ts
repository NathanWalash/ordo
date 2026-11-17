import { AiError } from './types'

/** Run at most `max` tasks at once; the rest wait their turn in order. */
export function limitConcurrency(max: number) {
  if (!(max >= 1)) throw new RangeError('max must be at least 1')
  let active = 0
  const queue: (() => void)[] = []
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve))
    active++
    try {
      return await task()
    } finally {
      active--
      queue.shift()?.()
    }
  }
}

export interface Deadline {
  signal: AbortSignal
  /** Turn an error thrown after the signal fired into a timeout or aborted AiError. */
  explain(err: unknown, what: string): unknown
  dispose(): void
}

/** Combine the caller's signal with a timeout, and say afterwards which one fired. */
export function deadline(signal: AbortSignal | undefined, timeoutMs: number | undefined): Deadline {
  const controller = new AbortController()
  let timedOut = false
  const timer =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort(new AiError('timeout', 'timed out'))
        }, timeoutMs)
      : undefined
  const onAbort = () => controller.abort(new AiError('aborted', 'Stopped.'))
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    explain(err, what) {
      if (err instanceof AiError && err.code !== 'timeout' && err.code !== 'aborted') return err
      if (timedOut)
        return new AiError('timeout', `${what} didn't answer within ${Math.round(timeoutMs! / 1000)} s.`, {
          cause: err,
        })
      if (controller.signal.aborted) return new AiError('aborted', 'Stopped.', { cause: err })
      return err
    },
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}
