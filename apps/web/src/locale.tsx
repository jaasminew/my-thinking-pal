import { createContext, useContext, type ReactNode } from 'react'

type Locale = {
  chinese: boolean
  tr: (english: string, chinese: string) => string
}

const LocaleContext = createContext<Locale>({
  chinese: false,
  tr: (english) => english
})

/** `/cn` is the Chinese product surface. API payloads and persisted data stay untouched. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const chinese = /^\/cn(?:\/|$)/.test(window.location.pathname)
  const value: Locale = { chinese, tr: (english, translated) => chinese ? translated : english }
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export const useLocale = () => useContext(LocaleContext)
