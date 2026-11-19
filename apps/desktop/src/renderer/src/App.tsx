import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AccountStatus, AppInfo } from '@ordo/shared'
import { ConnectSheet } from './components/ConnectSheet'
import { Sidebar } from './components/Sidebar'
import { Toolbar, ToolbarSlot } from './components/Toolbar'
import { HomePage } from './pages/HomePage'
import { MailPage } from './pages/MailPage'
import { UnclutterPage } from './pages/UnclutterPage'
import { FinancesPage } from './pages/FinancesPage'
import { BillsPage } from './pages/BillsPage'
import { AskPage } from './pages/AskPage'
import { CalendarPage } from './pages/CalendarPage'
import { BoardsPage } from './pages/BoardsPage'
import { HistoryPage } from './pages/HistoryPage'
import { SettingsPage } from './pages/SettingsPage'
import { routeFromHash, TITLES, type Route } from './routes'
import { useAppearanceClasses } from './appearance'
import { AssistantPanel, COMPOSER_ID, PANEL_ID } from './components/assistant/AssistantPanel'
import { useAssistant } from './components/assistant/useAssistant'

export function App() {
  const [route, setRouteState] = useState<Route>(() => routeFromHash(window.location.hash))
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [account, setAccount] = useState<AccountStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  // Mail shows the open mailbox's name in the toolbar.
  const [titleOverride, setTitleOverride] = useState<string | null>(null)
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null)
  const [assistantOpen, setAssistantOpen] = useState(false)
  /** Bumped when the assistant opens a page or finishes a change, so the page loads fresh data. */
  const [pageKey, setPageKey] = useState(0)
  const [financeMonth, setFinanceMonth] = useState<string | undefined>(undefined)
  const returnFocus = useRef<HTMLElement | null>(null)
  /** The content's width: wide enough, and the assistant sits beside it instead of over it. */
  const main = useRef<HTMLElement>(null)
  const [mainWidth, setMainWidth] = useState(0)
  useEffect(() => {
    const el = main.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setMainWidth(entry?.contentRect.width ?? 0))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useAppearanceClasses()

  const refreshAccount = useCallback(async () => setAccount(await window.ordo.account.status()), [])
  useEffect(() => {
    let live = true
    void window.ordo.account.status().then((a) => live && setAccount(a))
    return () => {
      live = false
    }
  }, [])

  const disconnect = async () => {
    await window.ordo.account.disconnect()
    await refreshAccount()
  }

  const setRoute = (r: Route) => {
    setFinanceMonth(undefined)
    window.location.hash = `/${r}`
  }

  const assistantHandlers = useMemo(
    () => ({
      onNavigate: (e: { page: string; month?: string }) => {
        const next = routeFromHash(`#/${e.page}`)
        setFinanceMonth(next === 'money/finances' ? e.month : undefined)
        setPageKey((k) => k + 1)
        window.location.hash = `/${next}`
      },
      onChanged: () => setPageKey((k) => k + 1),
    }),
    [],
  )
  const assistant = useAssistant(assistantHandlers)

  const openAssistant = useCallback(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setAssistantOpen(true)
  }, [])
  const closeAssistant = useCallback(() => {
    setAssistantOpen(false)
    returnFocus.current?.focus()
  }, [])

  // ⌘K or ⌘J (Ctrl on Windows and Linux) opens and closes the assistant from anywhere.
  const isMac = info ? info.platform === 'darwin' : navigator.userAgent.includes('Macintosh')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!mod || e.altKey || e.shiftKey) return
      const key = e.key.toLowerCase()
      if (key !== 'k' && key !== 'j') return
      e.preventDefault()
      if (!assistantOpen) return openAssistant()
      // Open but focus is elsewhere: go to the composer (or the panel) rather than closing.
      const panel = document.getElementById(PANEL_ID)
      if (panel && !panel.contains(document.activeElement))
        return void (document.getElementById(COMPOSER_ID) ?? panel).focus()
      closeAssistant()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMac, assistantOpen, openAssistant, closeAssistant])
  const shortcut = isMac ? '⌘K' : 'Ctrl+K'
  const docked = assistantOpen && mainWidth >= 1000

  useEffect(() => {
    const onHash = () => setRouteState(routeFromHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    void window.ordo.app.info().then((i) => {
      setInfo(i)
      document.documentElement.classList.add(`platform-${i.platform}`)
      if (i.accentColor) document.documentElement.style.setProperty('--accent', i.accentColor)
    })
  }, [])

  return (
    <div className="flex h-full">
      <Sidebar route={route} onNavigate={setRoute} platform={info?.platform} />
      <main ref={main} className="relative min-w-0 flex-1 bg-content border-l border-sep">
        <Toolbar
          title={(route === 'mail/inbox' && titleOverride) || TITLES[route]}
          platform={info?.platform}
          slotRef={setToolbarSlot}
          assistant={{
            open: assistantOpen,
            waiting: assistant.waiting,
            shortcut,
            onToggle: () => (assistantOpen ? closeAssistant() : openAssistant()),
          }}
        />
        {/* Content scrolls under the translucent toolbar, so pages start 52px down. */}
        <ToolbarSlot.Provider value={toolbarSlot}>
          <div
            key={pageKey}
            className="absolute inset-0 flex flex-col overflow-auto pt-[52px]"
            style={docked ? { right: 404 } : undefined}
          >
            {route === 'home' && <HomePage onNavigate={setRoute} />}
            {route === 'mail/inbox' && (
              <MailPage account={account} onConnect={() => setConnecting(true)} onTitle={setTitleOverride} />
            )}
            {route === 'mail/unclutter' && (
              <UnclutterPage
                key={account?.connected ? account.email : 'sample'}
                account={account}
                onConnect={() => setConnecting(true)}
                onScanned={() => void refreshAccount()}
                onOpenSettings={() => setRoute('settings')}
              />
            )}
            {route === 'mail/history' && <HistoryPage key={account?.connected ? account.email : 'none'} />}
            {route === 'calendar' && <CalendarPage account={account} onConnect={() => setConnecting(true)} />}
            {route === 'boards' && <BoardsPage onNavigate={setRoute} />}
            {route === 'money/finances' && (
              <FinancesPage onOpenSettings={() => setRoute('settings')} initialMonth={financeMonth} />
            )}
            {route === 'money/bills' && <BillsPage onNavigate={setRoute} />}
            {route === 'money/ask' && <AskPage onNavigate={setRoute} />}
            {route === 'settings' && (
              <SettingsPage
                account={account}
                onConnect={() => setConnecting(true)}
                onDisconnect={() => void disconnect()}
              />
            )}
          </div>
        </ToolbarSlot.Provider>
        {assistantOpen && (
          <AssistantPanel
            assistant={assistant}
            route={route}
            shortcut={shortcut}
            docked={docked}
            onClose={closeAssistant}
            onOpenSettings={() => setRoute('settings')}
          />
        )}
        {connecting && (
          <ConnectSheet
            onClose={() => setConnecting(false)}
            onConnected={() => {
              setConnecting(false)
              void refreshAccount()
              // Stay on Calendar or Settings if that's where you connected from.
              if (route !== 'calendar' && route !== 'settings') setRoute('mail/unclutter')
            }}
          />
        )}
      </main>
    </div>
  )
}
