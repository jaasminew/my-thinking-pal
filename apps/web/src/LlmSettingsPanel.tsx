import { useState } from 'react'

export type ModelSelections = {
  transcriptionSummary: number
  coCreation: number
  aiCommand: number
}

export type SelectableModel = {
  label: string
}

export function LlmSettingsPanel({
  models,
  selections,
  onSave,
  onClose
}: {
  models: readonly SelectableModel[]
  selections: ModelSelections
  onSave: (next: ModelSelections) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<ModelSelections>(selections)

  const patch = (key: keyof ModelSelections, value: number) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const save = () => {
    onSave(draft)
    onClose()
  }

  return (
    <div className="llm-settings-overlay" onPointerDown={onClose}>
      <div className="llm-settings" onPointerDown={(e) => e.stopPropagation()}>
        <div className="llm-settings-head">
          <strong>Settings</strong>
          <button className="llm-settings-x" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <section className="llm-section">
          <h2>Model Selection</h2>

          <label className="llm-field">
            <span>Transcription summary</span>
            <select
              value={draft.transcriptionSummary}
              onChange={(e) => patch('transcriptionSummary', Number(e.target.value))}
            >
              {models.map((m, i) => (
                <option key={i} value={i}>{m.label}</option>
              ))}
            </select>
          </label>

          <label className="llm-field">
            <span>Co-creation</span>
            <select value={draft.coCreation} onChange={(e) => patch('coCreation', Number(e.target.value))}>
              {models.map((m, i) => (
                <option key={i} value={i}>{m.label}</option>
              ))}
            </select>
          </label>

          <label className="llm-field">
            <span>AI command</span>
            <select value={draft.aiCommand} onChange={(e) => patch('aiCommand', Number(e.target.value))}>
              {models.map((m, i) => (
                <option key={i} value={i}>{m.label}</option>
              ))}
            </select>
          </label>
        </section>

        <div className="llm-settings-actions">
          <button className="llm-save" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
