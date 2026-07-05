import { useState } from 'react'
import { isImeEvent } from './ime'

// Tier-3 command pill, floating at the bottom of the canvas. Left: a capture
// affordance placeholder. Right: an explicit command to the AI.
export function CommandBar({
  recording,
  onToggleRecord,
  onSubmit
}: {
  recording: boolean
  onToggleRecord: () => void
  onSubmit: (command: string) => void
}) {
  const [value, setValue] = useState('')

  const submit = () => {
    const v = value.trim()
    if (!v) return
    onSubmit(v)
    setValue('')
  }

  return (
    <div className="command-bar" onClick={(e) => e.stopPropagation()}>
      <button
        className={`record ${recording ? 'on' : ''}`}
        title={recording ? 'Stop recording' : 'Start recording'}
        onClick={onToggleRecord}
      >
        {recording ? <span className="stop-sq" /> : <span className="rec-dot" />}
      </button>

      <div className="cmd-input">
        <span className="spark">✦</span>
        <input
          value={value}
          placeholder="Ask AI to search, draw, or expand…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (!isImeEvent(e) && e.key === 'Enter') submit() }}
        />
        <button className="send" title="Send" onClick={submit}>↑</button>
      </div>
    </div>
  )
}
