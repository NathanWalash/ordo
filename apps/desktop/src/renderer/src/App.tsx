import { useCallback, useEffect, useState } from 'react'
import type { AccountStatus, AppInfo } from '@ordo/shared'
import { ConnectSheet } from './components/ConnectSheet'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { HomePage } from './pages/HomePage'
import { InboxPage } from './pages/InboxPage'
import { UnclutterPage } from './pages/UnclutterPage'
import { FinancePage } from './pages/FinancePage'
import { SettingsPage } from './pages/SettingsPage'
import { routeFromHash, TITLES, type Route } from './routes'

export function App() {
  const [route, setRouteState] = useState<Route>(() => routeFromHash(window.location.hash))
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [account, setAccount] = useState<AccountStatus | null>(null)
  const [connecting, setConnecting] = useState(false)

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
      <main className="relative flex min-w-0 flex-1 flex-col bg-content border-l border-sep">
        <Toolbar title={TITLES[route]} platform={info?.platform} />
        <div className="min-h-0 flex-1 overflow-auto">
          {route === 'home' && <HomePage onNavigate={setRoute} />}
          {route === 'mail/inbox' && (
            <InboxPage
              account={account}
              onConnect={() => setConnecting(true)}
              onDisconnect={() => void disconnect()}
              onNavigate={setRoute}
            />
          )}
          {route === 'mail/unclutter' && (
            <UnclutterPage
              key={account?.connected ? account.email : 'sample'}
              account={account}
              onConnect={() => setConnecting(true)}
              onScanned={() => void refreshAccount()}
            />
          )}
          {route === 'finance' && <FinancePage />}
          {route === 'settings' && <SettingsPage />}
        </div>
        {connecting && (
          <ConnectSheet
            onClose={() => setConnecting(false)}
            onConnected={() => {
              setConnecting(false)
              void refreshAccount()
              setRoute('mail/unclutter')
            }}
          />
        )}
      </main>
    </div>
  )
}
