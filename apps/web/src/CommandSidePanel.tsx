import { useEffect, useRef, useState } from 'react'
import { actionLabel, type CommandSession } from './command-session'
import { isImeEvent } from './ime'

// Temporary Tier-3 chat panel, pinned to the right edge of its CanvasSpace
// (rendered inside .panel-body, NOT at workspace level — sessions belong to
// one space's notes, and with two paper-stack sheets open a workspace overlay
// would ambiguously cover the wrong one). Overlays the canvas; closing it ends
// the conversation: aborts any in-flight stream and clears the context
// highlight (wired in App).
export function CommandSidePanel({
  session,
  streaming,
  onSend,
  onApplyAction,
  onClose
}: {
  session: CommandSession
  streaming: boolean
  onSend: (text: string) => void
  onApplyAction: (messageId: string, actionId: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Keep the newest message in view while streaming.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session.messages])

  const submit = () => {
    const v = value.trim()
    if (!v || streaming) return
    onSend(v)
    setValue('')
  }

  return (
    <aside className="cmd-panel" onPointerDown={(e) => e.stopPropagation()}>
      <header className="cmd-panel-head">
        <span className="cmd-panel-title">{session.title}</span>
        <button className="cmd-panel-close" title="Close conversation" onClick={onClose}>×</button>
      </header>

      {session.source?.selectedText && (
        <div className="cmd-context-chip" title={session.source.selectedText}>
          “{session.source.selectedText}”
        </div>
      )}

      <div className="cmd-msgs" ref={scrollRef}>
        {session.messages.map((m) => (
          <div key={m.id} className={`cmd-msg ${m.role}`}>
            <div className="cmd-msg-text">
              {m.text || (m.pending ? <span className="cmd-thinking ai-thinking">Thinking…</span> : null)}
            </div>
            {!!m.actions?.length && (
              <div className="cmd-actions">
                {m.actions.map((pa) => (
                  <button
                    key={pa.id}
                    className={`cmd-action ${pa.applied ? 'applied' : ''}`}
                    disabled={pa.applied}
                    onClick={() => onApplyAction(m.id, pa.id)}
                  >
                    {pa.applied ? '✓ ' : '+ '}
                    {actionLabel(pa.action)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="cmd-panel-input">
        <textarea
          value={value}
          placeholder="Reply…"
          rows={1}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (isImeEvent(e)) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button className="send" title="Send" disabled={streaming} onClick={submit}>↑</button>
      </div>
    </aside>
  )
}
