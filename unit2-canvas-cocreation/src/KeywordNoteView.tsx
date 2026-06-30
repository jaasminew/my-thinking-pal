import type { KeywordNote } from './canvas-types'

// Renders one free-floating keyword note: keyword header → bullets → URL cards.
// All editing/drag/accept logic lives in App; this is presentational + inputs.
export function KeywordNoteView({
  note,
  selected,
  onPointerDownNote,
  onKeywordChange,
  onKeywordCommit,
  onBulletChange,
  onBulletEnter,
  onBulletEdit,
  onBulletBlur,
  onKeepBullet,
  onRejectBullet,
  onKeepCard,
  onRejectCard
}: {
  note: KeywordNote
  selected: boolean
  onPointerDownNote: (e: React.PointerEvent) => void
  onKeywordChange: (text: string) => void
  onKeywordCommit: () => void
  onBulletChange: (bulletId: string, text: string) => void
  onBulletEnter: (bulletId: string) => void
  onBulletEdit: (bulletId: string) => void
  onBulletBlur: (bulletId: string) => void
  onKeepBullet: (bulletId: string) => void
  onRejectBullet: (bulletId: string) => void
  onKeepCard: (cardId: string) => void
  onRejectCard: (cardId: string) => void
}) {
  return (
    <div
      className={`knote ${selected ? 'selected' : ''}`}
      data-noteid={note.id}
      style={{ left: note.x, top: note.y }}
      onPointerDown={onPointerDownNote}
    >
      {/* keyword header (hand-circled in the design) */}
      <div className="kw-header">
        {note.keywordEditing ? (
          <input
            className="kw-input"
            autoFocus
            value={note.keyword}
            placeholder="keyword…"
            onChange={(e) => onKeywordChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onKeywordCommit() } }}
            onBlur={onKeywordCommit}
          />
        ) : (
          <span className="kw-text">{note.keyword || 'untitled'}</span>
        )}
      </div>

      {/* bullets: human first, then AI (pending grey) */}
      <ul className="bullets">
        {note.bullets.map((b) => (
          <li key={b.id} className={`bullet ${b.origin} ${b.editing ? 'editing' : b.status}`}>
            <span className="dot">•</span>
            {b.editing ? (
              <input
                className="bullet-input"
                autoFocus
                value={b.text}
                placeholder="type an idea…"
                onChange={(e) => onBulletChange(b.id, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onBulletEnter(b.id) } }}
                onBlur={() => onBulletBlur(b.id)}
              />
            ) : (
              // Click any bullet — human or AI — to edit it in place.
              <span className="bullet-text" title="Click to edit" onClick={() => onBulletEdit(b.id)}>
                {b.text || '…'}
              </span>
            )}
            {b.origin === 'ai' && b.status === 'pending' && !b.editing && (
              <span className="accept">
                <button className="ok" title="Keep" onClick={() => onKeepBullet(b.id)}>✓</button>
                <button className="no" title="Reject" onClick={() => onRejectBullet(b.id)}>✕</button>
              </span>
            )}
          </li>
        ))}
      </ul>

      {/* AI inspiration URL cards */}
      {note.cards.map((c) => (
        <a
          key={c.id}
          className={`url-card ${c.status}`}
          href={c.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="thumb" style={c.image ? { backgroundImage: `url(${c.image})` } : undefined} />
          <div className="meta">
            <div className="t">{c.title}</div>
            <div className="d">{c.snippet || c.url}</div>
          </div>
          {c.status === 'pending' && (
            <div className="accept">
              <button className="ok" title="Keep" onClick={(e) => { e.preventDefault(); onKeepCard(c.id) }}>✓</button>
              <button className="no" title="Reject" onClick={(e) => { e.preventDefault(); onRejectCard(c.id) }}>✕</button>
            </div>
          )}
        </a>
      ))}
    </div>
  )
}
