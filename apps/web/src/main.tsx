import './styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { DesignSystemPage } from './DesignSystemPage'
import { initializeDesignTokens } from './design-tokens'

initializeDesignTokens()

const isDesignSystem = new URLSearchParams(window.location.search).has('design-system')

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isDesignSystem ? <DesignSystemPage /> : <App />}
  </React.StrictMode>
)
