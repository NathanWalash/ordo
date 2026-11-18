import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AssistantEvent, AssistantInfo } from '@ordo/shared'
import { applyEvent, cardOpen, finish, type Item } from './conversation'

export interface Assistant {
  info: AssistantInfo | null
  items: Item[]
  busy: boolean
  /** A card is waiting for the user. */
  waiting: boolean
  /** The unsent question, kept while the panel is closed. */
  draft: string
  setDraft(text: string): void
  ask(text: string, page: string): Promise<void>
  answerCard(id: string, approve: boolean): void
  setCloudConsent(allow: boolean): Promise<void>
  stop(): void
  clear(): void
  refreshInfo(): void
}

/**
 * The conversation, held by App so it survives closing the panel. It lives in memory only, like
 * the main process's copy: quitting Ordo, reloading or pressing New conversation forgets it.
 */
export function useAssistant(handlers: {
  onNavigate: (e: Extract<AssistantEvent, { type: 'navigate' }>) => void
  /** A confirmed change finished: pages showing data should reload. */
  onChanged: () => void
}): Assistant {
  const [info, setInfo] = useState<AssistantInfo | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const nextId = useRef(1)
  const on = useRef(handlers)
  useEffect(() => {
    on.current = handlers
  }, [handlers])

  const refreshInfo = useCallback(() => {
    void window.ordo.assistant.info().then(setInfo)
  }, [])

  useEffect(
    () =>
      window.ordo.assistant.onEvent((e) => {
        if (e.type === 'navigate') on.current.onNavigate(e)
        if (e.type === 'tool' && e.kind === 'change' && e.status !== 'running') on.current.onChanged()
        setItems((all) => applyEvent(all, e))
      }),
    [],
  )

  // A fresh window starts a fresh conversation: if main still has one (or a run) from before a
  // reload, this window can't show it, so end it.
  useEffect(() => {
    void window.ordo.assistant.info().then((i) => {
      setInfo(i)
      void window.ordo.assistant.clear()
    })
  }, [])

  const ask = useCallback(
    async (text: string, page: string) => {
      if (busy) return
      setBusy(true)
      setItems((all) => [
        ...all,
        { kind: 'user', id: nextId.current++, text },
        {
          kind: 'reply',
          id: nextId.current++,
          question: text,
          trace: [],
          status: 'Thinking',
          startedAt: Date.now(),
        },
      ])
      try {
        const outcome = await window.ordo.assistant.ask({ text, page })
        setItems((all) => finish(all, outcome, Date.now()))
      } catch {
        setItems((all) =>
          finish(
            all,
            { ok: false, reason: 'failed', message: 'Something went wrong. Try again.' },
            Date.now(),
          ),
        )
      } finally {
        setBusy(false)
      }
    },
    [busy],
  )

  const answerCard = useCallback((id: string, approve: boolean) => {
    void window.ordo.assistant.confirm({ id, approve })
  }, [])

  const setCloudConsent = useCallback(async (allow: boolean) => {
    setInfo(await window.ordo.assistant.setCloudConsent({ allow }))
  }, [])

  const stop = useCallback(() => void window.ordo.assistant.stop(), [])

  const clear = useCallback(() => {
    void window.ordo.assistant.clear()
    setItems([])
  }, [])

  const waiting = useMemo(() => cardOpen(items), [items])

  return {
    info,
    items,
    busy,
    waiting,
    draft,
    setDraft,
    ask,
    answerCard,
    setCloudConsent,
    stop,
    clear,
    refreshInfo,
  }
}
