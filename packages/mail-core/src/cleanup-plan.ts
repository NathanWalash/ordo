import type { CategorisedSender } from './analyse'
import type { Category, UnsubscribeMethod } from './types'
import { MAILTO_PER_CLEANUP_MAX, planMailto, type MailtoMessage } from './unsubscribe'

/** What the user asked for one sender in the review sheet. */
export interface CleanupRequestItem {
  address: string
  unsubscribe: boolean
  trash: boolean
  /** For a plain http unsubscribe link: the URL the sheet showed, echoed back as confirmation. */
  confirmedUrl?: string
  /** For a mailto unsubscribe to another domain: the recipient the sheet showed, echoed back as the user's tick. */
  confirmedRecipient?: string
}

/** One sender Ordo has agreed to act on. */
export interface PlannedSender {
  address: string
  name?: string
  category: Category
  /** Emails cached for this sender when the plan was made. */
  count: number
  /** The method to use, or null when the user didn't ask to unsubscribe (or there's no way to). */
  unsubscribe: UnsubscribeMethod | null
  insecureLinkConfirmed: boolean
  /** For mailto: the exact email to send (one recipient, checked subject and body). */
  mailto: MailtoMessage | null
  trash: boolean
  /** The accounts (ids) this sender's mail is in, when the analysis knew. */
  accounts?: string[]
}

export interface CleanupPlan {
  senders: PlannedSender[]
  rejected: { address: string; reason: string }[]
}

/**
 * Turn the review sheet's choices into a plan, checked against the sender
 * analysis in the main process. People (anyone categorised as such, or anyone
 * you've written to) are always refused, whatever the renderer sends.
 */
export function buildCleanupPlan(
  senders: readonly CategorisedSender[],
  repliedTo: ReadonlySet<string>,
  requests: readonly CleanupRequestItem[],
): CleanupPlan {
  const byAddress = new Map(senders.map((s) => [s.address, s]))
  const plan: CleanupPlan = { senders: [], rejected: [] }
  const seen = new Set<string>()
  let mailtos = 0
  for (const req of requests) {
    const address = req.address.trim().toLowerCase()
    if (seen.has(address)) continue
    seen.add(address)
    const reject = (reason: string) => plan.rejected.push({ address, reason })
    const s = byAddress.get(address)
    if (!s) {
      reject('Not in your scanned inbox')
      continue
    }
    if (s.category === 'people' || repliedTo.has(address)) {
      reject('Someone you’ve written to. Never included in bulk actions.')
      continue
    }
    const method = s.unsubscribe
    const insecure = method.kind === 'link' && !/^https:/i.test(method.url)
    if (req.unsubscribe && insecure && req.confirmedUrl !== method.url) {
      reject('The plain http unsubscribe link wasn’t confirmed')
      continue
    }
    let mailto: MailtoMessage | null = null
    if (req.unsubscribe && method.kind === 'mailto') {
      const planned = planMailto(method.url, s)
      if (!planned) {
        reject('The unsubscribe email address isn’t valid')
        continue
      }
      if (planned.offDomain && req.confirmedRecipient?.trim().toLowerCase() !== planned.message.to) {
        reject(`Email unsubscribe to a different domain (${planned.message.to}) wasn’t ticked`)
        continue
      }
      if (mailtos >= MAILTO_PER_CLEANUP_MAX) {
        reject(`At most ${MAILTO_PER_CLEANUP_MAX} unsubscribe emails per clean-up. Clear the rest next time.`)
        continue
      }
      mailtos++
      mailto = planned.message
    }
    const unsubscribe = req.unsubscribe && method.kind !== 'none' ? method : null
    if (!unsubscribe && !req.trash) {
      reject('Nothing to do')
      continue
    }
    plan.senders.push({
      address,
      name: s.name,
      category: s.category,
      count: s.count,
      unsubscribe,
      insecureLinkConfirmed: insecure && unsubscribe !== null,
      mailto,
      trash: req.trash,
      ...(s.accounts && { accounts: s.accounts }),
    })
  }
  return plan
}
