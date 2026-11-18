import { useCallback, useEffect, useState } from 'react'
import type { AccountStatus, AppInfo } from '@ordo/shared'
import { ConnectSheet } from './components/ConnectSheet'
import { Sidebar } from './components/Sidebar'
import { Toolbar, ToolbarSlot } from './components/Toolbar'
import { HomePage } from './pages/HomePage'
import { MailPage } from './pages/MailPage'
import { UnclutterPage } from './pages/UnclutterPage'
import { FinancesPage } from './pages/FinancesPage'
import { BillsPage } from './pages/BillsPage'
import { CalendarPage } from './pages/CalendarPage'
import { HistoryPage } from './pages/HistoryPage'
import { SettingsPage } from './pages/SettingsPage'
import { routeFromHash, TITLES, type Route } from './routes'
import { useAppearanceClasses } from './appearance'

export function App() {
  const [route, setRouteState] = useState<Route>(() => routeFromHash(window.location.hash))
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [account, setAccount] = useState<AccountStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  // Mail shows the open mailbox's name in the toolbar.
  const [titleOverride, setTitleOverride] = useState<string | null>(null)
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null)
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
    window.location.hash = `/${r}`
  }

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
      <main className="relative min-w-0 flex-1 bg-content border-l border-sep">
        <Toolbar
          title={(route === 'mail/inbox' && titleOverride) || TITLES[route]}
          platform={info?.platform}
          slotRef={setToolbarSlot}
        />
        {/* Content scrolls under the translucent toolbar, so pages start 52px down. */}
        <ToolbarSlot.Provider value={toolbarSlot}>
          <div className="absolute inset-0 flex flex-col overflow-auto pt-[52px]">
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
            {route === 'money/finances' && <FinancesPage onOpenSettings={() => setRoute('settings')} />}
            {route === 'money/bills' && <BillsPage onNavigate={setRoute} />}
            {route === 'settings' && (
              <SettingsPage
                account={account}
                onConnect={() => setConnecting(true)}
                onDisconnect={() => void disconnect()}
              />
            )}
          </div>
        </ToolbarSlot.Provider>
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
