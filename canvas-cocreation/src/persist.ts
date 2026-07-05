// Tiny localStorage persistence layer so testing data survives page refreshes
// and dev-server restarts. All saves are best-effort: a full quota or a
// disabled storage never breaks the app, the data just doesn't stick.
const PREFIX = 'thinking-pal-canvas.'

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

export function clearSaved() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(PREFIX)) localStorage.removeItem(k)
    }
  } catch {}
}
