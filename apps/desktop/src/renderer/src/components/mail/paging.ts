/** How close to the bottom of the message list (in pixels) the next page starts loading. */
export const END_MARGIN = 400

/**
 * Whether the end of a scrolling list is in view, or nearly: also true when the list doesn't fill
 * its box, since no scroll event will ever come to ask for more.
 */
export function nearEnd(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < END_MARGIN
}
