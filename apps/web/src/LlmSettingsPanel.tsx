import { useState } from 'react'
import { PROVIDER_PRESETS } from '../../../packages/core/llm'
import type { LlmSettings } from '../../../packages/core/settings/llm-settings'
import { getSettings, saveSettings } from '../../../services/llm/provider-config'

// Minimal settings modal so a PRODUCTION user (static build, no dev server) can
// enter their own MaaS key — the browser calls the provider directly with it
// (docs module 08). Keys live only in this browser's localStorage.
export function LlmSettingsPanel({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState<LlmSettings>(() => {
    const s = getSettings()
    return { ...s, providers: { ...s.providers } }
  })

  const ids = Object.keys(PROVIDER_PRESETS)
  const active = draft.activeProviderId
  const preset = PROVIDER_PRESETS[active]
  const cfg = draft.providers[active] ?? {}

  const patchActive = (patch: Partial<{ apiKey: string; model: string; baseUrl: string }>) =>
    setDraft((d) => ({ ...d, providers: { ...d.providers, [active]: { ...d.providers[active], ...patch } } }))

  const save = () => {
    saveSettings(draft)
    onClose()
  }

  return (
    <div className="llm-settings-overlay" onPointerDown={onClose}>
      <div className="llm-settings" onPointerDown={(e) => e.stopPropagation()}>
        <div className="llm-settings-head">
          <strong>LLM provider</strong>
          <button className="llm-settings-x" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <label className="llm-field">
          <span>Active provider</span>
          <select value={active} onChange={(e) => setDraft((d) => ({ ...d, activeProviderId: e.target.value }))}>
            {ids.map((id) => (
              <option key={id} value={id}>
                {PROVIDER_PRESETS[id].label}
              </option>
            ))}
          </select>
        </label>

        {!preset?.keyless && (
          <label className="llm-field">
            <span>API key</span>
            <input
              type="password"
              autoComplete="off"
              placeholder="stored in this browser only"
              value={cfg.apiKey ?? ''}
              onChange={(e) => patchActive({ apiKey: e.target.value })}
            />
          </label>
        )}

        <label className="llm-field">
          <span>Model</span>
          <input
            type="text"
            placeholder={preset?.defaultModel || 'model id'}
            value={cfg.model ?? ''}
            onChange={(e) => patchActive({ model: e.target.value })}
          />
        </label>

        <label className="llm-field">
          <span>Base URL</span>
          <input
            type="text"
            placeholder={preset?.baseUrl || 'https://…/v1'}
            value={cfg.baseUrl ?? ''}
            onChange={(e) => patchActive({ baseUrl: e.target.value })}
          />
        </label>

        <p className="llm-note">
          The browser calls this provider directly. Keys never leave this device and are not sent to any server.
        </p>

        <div className="llm-settings-actions">
          <button className="llm-save" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
