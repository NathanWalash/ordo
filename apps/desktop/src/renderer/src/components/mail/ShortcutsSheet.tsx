import { Keyboard } from 'lucide-react'
import { Button } from '../Button'
import { Sheet } from '../Sheet'

/** Every Mail shortcut: the single keys work while the message list or a message has focus. */
export const SHORTCUTS: { keys: string; does: string }[] = [
  { keys: '↑ ↓ or K J', does: 'Previous or next message' },
  { keys: '⌘N or C', does: 'New message' },
  { keys: '⌘R or R', does: 'Reply' },
  { keys: '⇧⌘R or A', does: 'Reply all' },
  { keys: '⇧⌘F or F', does: 'Forward' },
  { keys: '⌃⌘A or E', does: 'Archive' },
  { keys: '⌘⌫, Delete or #', does: 'Move to Bin' },
  { keys: '⇧⌘U or U', does: 'Mark as read or unread' },
  { keys: '⇧⌘L or S', does: 'Flag or unflag' },
  { keys: '⌘Z or Z', does: 'Undo the last move' },
  { keys: '⌘F or /', does: 'Search' },
  { keys: '⌘Return', does: 'Send, while writing' },
  { keys: '?', does: 'These shortcuts' },
]

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet
      title="Keyboard shortcuts"
      subtitle="Single keys work while the message list or a message has focus."
      icon={<Keyboard size={20} />}
      width={440}
      onClose={onClose}
      onSubmit={onClose}
      footer={
        <>
          <span className="flex-1" />
          <Button type="submit" variant="primary">
            Done
          </Button>
        </>
      }
    >
      <table className="w-full text-[13px]">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.does} className="border-b border-sep last:border-b-0">
              <td className="py-1.5 pr-4 whitespace-nowrap text-ink-2">{s.keys}</td>
              <td className="py-1.5">{s.does}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Sheet>
  )
}
