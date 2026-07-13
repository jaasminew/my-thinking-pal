import './styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { DesignSystemPage } from './DesignSystemPage'
import { initializeDesignTokens } from './design-tokens'
import { LocaleProvider } from './locale'

initializeDesignTokens()

const isDesignSystem = new URLSearchParams(window.location.search).has('design-system')

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocaleProvider>{isDesignSystem ? <DesignSystemPage /> : <App />}</LocaleProvider>
  </React.StrictMode>
)
