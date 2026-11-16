import { useEffect, useState } from 'react'
import type { AppInfo } from '@ordo/shared'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { HomePage } from './pages/HomePage'
import { InboxPage } from './pages/InboxPage'
import { FinancePage } from './pages/FinancePage'
import { routeFromHash, TITLES, type Route } from './routes'

export function App() {
  const [route, setRouteState] = useState<Route>(() => routeFromHash(window.location.hash))
  const [info, setInfo] = useState<AppInfo | null>(null)

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
      <main className="flex min-w-0 flex-1 flex-col bg-content border-l border-sep">
        <Toolbar title={TITLES[route]} platform={info?.platform} />
        <div className="min-h-0 flex-1 overflow-auto">
          {route === 'home' && <HomePage onNavigate={setRoute} />}
          {route === 'mail/inbox' && <InboxPage onNavigate={setRoute} />}
          {route === 'finance' && <FinancePage />}
        </div>
      </main>
    </div>
  )
}
