// Tiny localStorage persistence layer so testing data survives page refreshes
// and dev-server restarts. All saves are best-effort: a full quota or a
// disabled storage never breaks the app, the data just doesn't stick.
const PREFIX = 'thinking-pal-canvas.'
const BACKUP_VERSION = 1

type SavedBackup = {
  app: 'thinking-pal-canvas'
  version: number
  exportedAt: string
  items: Record<string, unknown>
}

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function saveJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // quota exceeded / storage disabled — skip this save
  }
}

export function exportSavedData(): SavedBackup {
  const items: Record<string, unknown> = {}
  try {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(PREFIX)) continue
      const key = k.slice(PREFIX.length)
      const raw = localStorage.getItem(k)
      if (raw === null) continue
      try {
        items[key] = JSON.parse(raw)
      } catch {
        items[key] = raw
      }
    }
  } catch {
    // storage disabled — return an empty but valid backup
  }
  return {
    app: 'thinking-pal-canvas',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    items
  }
}

export function downloadSavedData() {
  const backup = exportSavedData()
  const stamp = backup.exportedAt.replace(/[:.]/g, '-')
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `thinking-pal-canvas-${stamp}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function clearSaved() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(PREFIX)) localStorage.removeItem(k)
    }
  } catch {}
}
