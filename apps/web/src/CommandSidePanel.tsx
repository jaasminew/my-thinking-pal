import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { actionLabel, type CommandSession } from './command-session'
import { isImeEvent } from './ime'
import { useLocale } from './locale'

const faviconUrl = (url: string) => {
  try {
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).hostname)}&sz=32`
  } catch {
    return ''
  }
}

const DocumentFavicon = () => (
  <svg className="cmd-source-file" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M4 1.75h5l3 3v9.5H4z" fill="currentColor" opacity=".16" />
    <path d="M4 1.75h5l3 3v9.5H4zM9 1.75v3h3M6.2 8h3.6M6.2 10.25h3.6" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
  </svg>
)

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
  const { tr } = useLocale()
  const [value, setValue] = useState('')
  const [width, setWidth] = useState(420)
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)

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

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = panelRef.current?.offsetWidth ?? width
    const maxWidth = () => Math.min(600, panelRef.current?.parentElement?.clientWidth ?? 600)
    const onMove = (move: PointerEvent) => {
      setWidth(Math.max(300, Math.min(maxWidth(), startWidth + startX - move.clientX)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  return (
    <aside ref={panelRef} className="cmd-panel" style={{ width }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="cmd-panel-resize" role="separator" aria-orientation="vertical" onPointerDown={startResize} />
      <header className="cmd-panel-head">
        <span className="cmd-panel-title">{session.title}</span>
        <button className="cmd-panel-close" title={tr('Close conversation', '关闭对话')} onClick={onClose}>×</button>
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
              {m.text ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  skipHtml
                  components={{
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noreferrer">{children}</a>
                    )
                  }}
                >
                  {m.text}
                </ReactMarkdown>
              ) : (m.pending ? <span className="cmd-thinking ai-thinking">{tr('Thinking…', '思考中…')}</span> : null)}
            </div>
            {!!m.sources?.length && (
              <div className="cmd-sources" aria-label={tr('Sources', '来源')}>
                <span className="cmd-sources-label">{tr('Sources:', '来源：')}</span>
                {m.sources.map((source) => source.kind === 'web' ? (
                  <a
                    key={`web:${source.url}`}
                    className="cmd-source-link"
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    title={source.url}
                  >
                    <img src={faviconUrl(source.url)} alt="" onError={(e) => { e.currentTarget.style.display = 'none' }} />
                    <span>{source.title}</span>
                  </a>
                ) : (
                  <span key={`knowledge:${source.id}`} className="cmd-source-link knowledge" title={tr('Knowledge base', '知识库')}>
                    <DocumentFavicon />
                    <span>{source.title}</span>
                  </span>
                ))}
              </div>
            )}
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
          placeholder={tr('Reply…', '回复…')}
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
        <button className="send" title={tr('Send', '发送')} disabled={streaming} onClick={submit}>↑</button>
      </div>
    </aside>
  )
}
