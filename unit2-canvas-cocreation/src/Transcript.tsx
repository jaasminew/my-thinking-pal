// Left pane. Static bilingual placeholder for the scaffold; in the stitched demo
// it's fed by Unit 1's STT (services/stt). Native selection-drag carries the
// selected phrase as text/plain — the canvas reads it on drop.
//
// A few spans are pre-marked as Tier-1 ambient highlights (the weak model's job)
// so the drag affordance is obvious. `<mark className="kw">` = a draggable keyword.

interface Line {
  text: string
  // Phrases inside `text` to render as highlighted, draggable keywords.
  kw?: string[]
}

export const LINES: Line[] = [
  { text: '如果我们能在头脑风暴的时候，把转瞬即逝的灵感实时抓住，', kw: ['实时抓住'] },
  { text: '在右边的画布上做一些重点的标注，并且让 AI 一起参与进来，', kw: ['重点的标注'] },
  { text: 'and then it would do some brainstorming with me — real time, co-creation.', kw: ['real time', 'co-creation'] },
  { text: '比如说，我现在在讲话的时候，它就能帮我把它画出来，', kw: ['帮我把它画出来'] },
  { text: "the point is it's fast and will even boost what I am about to say.", kw: ['fast'] }
]

// Split a line into plain text + draggable <mark> spans for its keywords.
function render(line: Line, i: number) {
  if (!line.kw?.length) return <p key={i}>{line.text}</p>
  let rest = line.text
  const out: React.ReactNode[] = []
  let k = 0
  for (const phrase of line.kw) {
    const idx = rest.indexOf(phrase)
    if (idx < 0) continue
    if (idx > 0) out.push(<span key={`t${k++}`}>{rest.slice(0, idx)}</span>)
    out.push(
      <mark key={`k${k++}`} className="kw" draggable
        onDragStart={(e) => e.dataTransfer.setData('text/plain', phrase)}>
        {phrase}
      </mark>
    )
    rest = rest.slice(idx + phrase.length)
  }
  if (rest) out.push(<span key={`t${k++}`}>{rest}</span>)
  return <p key={i}>{out}</p>
}

// Full transcript as plain text — sent to the AI as context for co-creation.
export const TRANSCRIPT_TEXT = LINES.map((l) => l.text).join('\n')

export function Transcript() {
  return (
    <aside className="transcript">
      <div className="hint">
        Drag a highlighted phrase onto the canvas → or just click the canvas and type
      </div>
      {LINES.map(render)}
    </aside>
  )
}
