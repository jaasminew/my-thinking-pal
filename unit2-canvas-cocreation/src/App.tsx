import { useCallback, useEffect, useRef, useState } from 'react'
import { Transcript } from './Transcript'
import { CommandBar } from './CommandBar'
import { KeywordNoteView } from './KeywordNoteView'
import { uid, isBullet, isCard, type KeywordNote, type NoteItem, type BulletItem, type CardItem } from './canvas-types'
import { requestCocreate } from '../../services/llm/cocreate'
import type { CocreateProvider, OpenSub } from '../../services/llm/cocreate-types'

const PROVIDERS: { id: CocreateProvider; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'open', label: 'Open + Tavily' }
]
const OPEN_MODELS: { sub: OpenSub; model: string; label: string }[] = [
  { sub: 'groq', model: 'llama-3.3-70b-versatile', label: 'Groq · Llama 3.3 70B' },
  { sub: 'groq', model: 'openai/gpt-oss-120b', label: 'Groq · GPT-OSS 120B' },
  { sub: 'groq', model: 'qwen/qwen3-32b', label: 'Groq · Qwen3 32B' },
  { sub: 'ollama', model: '', label: 'Ollama · local (.env)' }
]

// Strip a leading bullet marker ("- ", "• ", "* ") from a model line.
const stripMarker = (l: string) => l.replace(/^[\s\-*•]+/, '').trim()

// Drop model chatter that isn't a real bullet (search preamble, a Sources list,
// a bare markdown link line). Safety net on top of the prompt instructions.
const META = /^(i['’]?ll\b|i will\b|let me\b|i['’]?m going\b|searching\b|here'?s?\b|sources?\b|first[,:]? i)/i
const isContentBullet = (l: string) =>
  l.length > 0 && !META.test(l) && !/^\[.*\]\(https?:\/\//.test(l) && !/^URLS:/i.test(l)

// Count "words": each CJK char = 1, each latin run = 1. Drives the every-20 fire.
const countWords = (s: string) => {
  const cjk = (s.match(/[一-鿿]/g) || []).length
  const latin = (s.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9']+/g) || []).length
  return cjk + latin
}
// Human words in a note = keyword + the user's bullets (AI output doesn't count).
const humanWords = (n: KeywordNote) =>
  countWords([n.keyword, ...n.items.filter((i): i is BulletItem => isBullet(i) && i.origin === 'human').map((b) => b.text)].join(' '))

// URLs the user types/pastes into a bullet get pulled out into inline cards.
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g
const hostOf = (u: string) => {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u }
}

// Commit a bullet: strip typed URLs into gray cards placed right after it, and
// (on ⏎) continue the outline with a fresh editing bullet below — regardless of
// whether the committed line was human or accepted AI: laid-down text is text.
const commitBullet = (b: BulletItem, continueOutline: boolean): NoteItem[] => {
  const urls = b.text.match(URL_RE) || []
  const text = b.text.replace(URL_RE, ' ').replace(/\s+/g, ' ').trim()
  const out: NoteItem[] = []
  if (text) out.push({ ...b, text, editing: false })
  for (const u of urls) {
    out.push({ kind: 'card', id: uid('c'), origin: 'human', status: 'kept', title: hostOf(u), url: u })
  }
  // ⏎ on an empty bullet ends the outline instead of opening another one.
  if (continueOutline && out.length) {
    out.push({ kind: 'bullet', id: uid('b'), origin: 'human', text: '', status: 'kept', editing: true })
  }
  return out
}

export function App() {
  const [notes, setNotes] = useState<KeywordNote[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null)
  const [recording, setRecording] = useState(false)

  const [provider, setProvider] = useState<CocreateProvider>('codex')
  const [openIdx, setOpenIdx] = useState(0)
  const [webSearch, setWebSearch] = useState(true)
  // AI co-creation mode: OFF suppresses ambient fires and cancels in-flight
  // ones. Tier-3 commands stay live — an explicit command is an invitation.
  const [aiEnabled, setAiEnabled] = useState(true)

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const notesRef = useRef<KeywordNote[]>(notes)
  useEffect(() => { notesRef.current = notes }, [notes])
  const selectedIdsRef = useRef(selectedIds)
  useEffect(() => { selectedIdsRef.current = selectedIds }, [selectedIds])
  const aiBufRef = useRef<Record<string, string>>({})
  const aiEnabledRef = useRef(true)
  useEffect(() => { aiEnabledRef.current = aiEnabled }, [aiEnabled])
  // In-flight fires, so switching AI off can cancel ambient streams immediately.
  const firesRef = useRef(new Map<string, { controller: AbortController; isCommand: boolean }>())
  // Live cleaned transcript, fed by <Transcript>. Kept in a ref so runAi always
  // reads the latest text without re-creating the callback on every word.
  const transcriptTextRef = useRef('')
  const onTranscriptChange = useCallback((t: string) => { transcriptTextRef.current = t }, [])

  // Mass delete: ⌫/Delete removes all selected notes (unless typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (e.defaultPrevented) return // e.g. ⌫ on a focused url card = delete that card only
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || (ae as HTMLElement).isContentEditable)) return
      if (selectedIdsRef.current.size === 0) return
      e.preventDefault()
      const del = selectedIdsRef.current
      setNotes((ns) => ns.filter((n) => !del.has(n.id)))
      setSelectedIds(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const patchNote = useCallback((id: string, fn: (n: KeywordNote) => KeywordNote) => {
    setNotes((ns) => ns.map((n) => (n.id === id ? fn(n) : n)))
  }, [])

  const providerArgs = useCallback(() => {
    if (provider === 'open') {
      const m = OPEN_MODELS[openIdx]
      return { provider, openSub: m.sub, model: m.model || undefined, webSearch }
    }
    return { provider, webSearch }
  }, [provider, openIdx, webSearch])

  const toLocal = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: clientX - r.left, y: clientY - r.top }
  }

  // ---- AI co-creation: ONE increment per fire, appended (never replaces prior
  // suggestions), informed by the full transcript, the note, and what the user
  // has KEPT / REJECTED so far. Reads accumulate → the next suggestion sharpens.
  const runAi = useCallback(
    async (noteId: string, command?: string) => {
      const note = notesRef.current.find((n) => n.id === noteId)
      if (!note) return

      const isCommand = typeof command === 'string' && command.trim().length > 0
      if (!isCommand && !aiEnabledRef.current) return // ambient fires respect the switch

      const humanBullets = note.items.filter((i): i is BulletItem => isBullet(i) && i.origin === 'human' && !!i.text.trim())
      const seed = note.keyword.trim() || humanBullets[0]?.text || ''
      // Only PERMANENT (kept) AI content is context for the next call; pending
      // suggestions are temporary — they may be rejected, so they don't count.
      const existingIdeas = note.items
        .filter((i) => i.origin === 'ai' && i.status === 'kept')
        .map((i) => (isBullet(i) ? i.text : i.title))
      const fireId = uid('f')
      aiBufRef.current[fireId] = ''
      const controller = new AbortController()
      firesRef.current.set(fireId, { controller, isCommand })
      patchNote(noteId, (n) => ({ ...n, aiRunning: true }))

      const result = await requestCocreate(
        {
          seedText: seed,
          command,
          contextNotes: humanBullets.map((b) => b.text),
          kept: note.kept,
          rejected: note.rejected,
          existingIdeas,
          transcriptWindow: transcriptTextRef.current,
          ...providerArgs()
        },
        {
          onText: (chunk) => {
            aiBufRef.current[fireId] = (aiBufRef.current[fireId] || '') + chunk
            // One increment → keep only the first content bullet of THIS fire.
            const lines = aiBufRef.current[fireId]
              .split('\n')
              .flatMap((l) => l.split(/(?<=[.!?])\s*(?=[-•*]\s)/))
              .map(stripMarker)
              .filter(isContentBullet)
              .slice(0, 1)
            setNotes((ns) =>
              ns.map((n) => {
                if (n.id !== noteId) return n
                const t = lines[0]
                if (t === undefined) return n
                // Upsert this fire's bullet IN PLACE (appended at the end on
                // first sight). Once the user has accepted (or started editing)
                // it, the stream stops overwriting their version.
                const idx = n.items.findIndex((it) => isBullet(it) && it.fireId === fireId)
                if (idx >= 0) {
                  const cur = n.items[idx] as BulletItem
                  if (cur.status !== 'pending') return n
                  const items = [...n.items]
                  items[idx] = { ...cur, text: t }
                  return { ...n, items }
                }
                return { ...n, items: [...n.items, { kind: 'bullet', id: uid('b'), origin: 'ai', fireId, text: t, status: 'pending' }] }
              })
            )
          },
          onUrls: (urls) => {
            patchNote(noteId, (n) => ({
              ...n,
              items: [...n.items, ...urls.slice(0, 1).map((u): CardItem => ({ ...u, kind: 'card', id: uid('c'), origin: 'ai', status: 'pending' }))]
            }))
          }
        },
        controller.signal
      )

      firesRef.current.delete(fireId)
      if (result.aborted) {
        // Cancelled by the switch: discard this fire's partial suggestion.
        delete aiBufRef.current[fireId]
        patchNote(noteId, (n) => ({
          ...n,
          aiRunning: false,
          items: n.items.filter((it) => !(isBullet(it) && it.fireId === fireId))
        }))
        return
      }

      patchNote(noteId, (n) => {
        if (result.error && !aiBufRef.current[fireId]?.trim()) {
          return {
            ...n,
            aiRunning: false,
            items: [...n.items, { kind: 'bullet', id: uid('b'), origin: 'ai', fireId, text: `⚠ ${result.error}`, status: 'pending' }]
          }
        }
        return { ...n, aiRunning: false }
      })
    },
    [patchNote, providerArgs]
  )

  // ---- the trigger: fire ONE increment each time human word count grows by 20 ----
  useEffect(() => {
    if (!aiEnabled) return
    for (const n of notes) {
      if (n.aiRunning || n.keywordEditing) continue
      const words = humanWords(n)
      if (words - n.lastFiredWords >= 20) {
        patchNote(n.id, (x) => ({ ...x, lastFiredWords: words }))
        void runAi(n.id)
      }
    }
  }, [notes, aiEnabled, patchNote, runAi])

  // ---- AI co-creation switch. Back ON resets each note's baseline to its
  // CURRENT word count, so writing done while off never triggers a burst of
  // stale suggestions. OFF cancels in-flight ambient fires (commands finish).
  const toggleAi = useCallback(() => {
    const next = !aiEnabledRef.current
    if (next) {
      setNotes((ns) => ns.map((n) => ({ ...n, lastFiredWords: humanWords(n) })))
    } else {
      for (const f of firesRef.current.values()) {
        if (!f.isCommand) f.controller.abort()
      }
    }
    setAiEnabled(next)
  }, [])

  // ---- canvas: drag blank = marquee-select (框选); plain click = new note ----
  const onCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.target !== canvasRef.current) return // only on truly blank space
    const startC = { x: e.clientX, y: e.clientY }
    const rect = canvasRef.current!.getBoundingClientRect()
    const start = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    let moved = false

    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startC.x) > 4 || Math.abs(ev.clientY - startC.y) > 4) moved = true
      const cur = { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
      const l = Math.min(start.x, cur.x), t = Math.min(start.y, cur.y)
      const w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y)
      setMarquee({ l, t, w, h })
      if (!moved) return
      const box = { left: l, top: t, right: l + w, bottom: t + h }
      const sel = new Set<string>()
      for (const n of notesRef.current) {
        const el = document.querySelector(`[data-noteid="${n.id}"]`) as HTMLElement | null
        if (!el) continue
        const r = el.getBoundingClientRect()
        const nb = { left: r.left - rect.left, top: r.top - rect.top, right: r.right - rect.left, bottom: r.bottom - rect.top }
        if (nb.left < box.right && nb.right > box.left && nb.top < box.bottom && nb.bottom > box.top) sel.add(n.id)
      }
      setSelectedIds(sel)
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      setMarquee(null)
      if (!moved) {
        const id = uid('n')
        setNotes((ns) => [...ns, { id, x: start.x, y: start.y, keyword: '', keywordEditing: true, items: [], aiRunning: false, kept: [], rejected: [], lastFiredWords: 0 }])
        setSelectedIds(new Set([id]))
      }
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }, [])

  // ---- canvas: drop a transcript keyword = new note + auto blinking bullet ----
  const onDrop = useCallback((e: React.DragEvent) => {
    const text = e.dataTransfer.getData('text/plain').trim()
    if (!text) return
    e.preventDefault()
    const { x, y } = toLocal(e.clientX, e.clientY)
    const id = uid('n')
    setNotes((ns) => [
      ...ns,
      {
        id, x, y, keyword: text, keywordEditing: false, aiRunning: false,
        kept: [], rejected: [], lastFiredWords: 0,
        items: [{ kind: 'bullet', id: uid('b'), origin: 'human', text: '', status: 'kept', editing: true }]
      }
    ])
    setSelectedIds(new Set([id]))
  }, [])

  // ---- keyword header editing ----
  const onKeywordChange = (id: string) => (text: string) =>
    patchNote(id, (n) => ({ ...n, keyword: text }))

  const onKeywordCommit = (id: string) => () => {
    const n = notesRef.current.find((x) => x.id === id)
    if (!n) return
    if (!n.keyword.trim() && n.items.length === 0) {
      setNotes((ns) => ns.filter((x) => x.id !== id)) // empty click → discard
      return
    }
    patchNote(id, (nn) => ({
      ...nn,
      keywordEditing: false,
      items: nn.items.length
        ? nn.items
        : [{ kind: 'bullet', id: uid('b'), origin: 'human', text: '', status: 'kept', editing: true }]
    }))
  }

  // ---- bullet editing ----
  const onBulletChange = (id: string) => (bulletId: string, text: string) =>
    patchNote(id, (n) => ({ ...n, items: n.items.map((it) => (it.id === bulletId && isBullet(it) ? { ...it, text } : it)) }))

  // Replace one bullet with its committed form (URL cards split out, optional
  // fresh editing bullet after) — splice keeps the item's position in the flow.
  const spliceCommit = (id: string, bulletId: string, continueOutline: boolean) =>
    patchNote(id, (n) => {
      const idx = n.items.findIndex((it) => it.id === bulletId)
      const b = n.items[idx]
      if (!b || !isBullet(b)) return n
      return { ...n, items: [...n.items.slice(0, idx), ...commitBullet(b, continueOutline), ...n.items.slice(idx + 1)] }
    })

  // ⏎ inside any bullet — human or laid-down AI — commits it and opens a fresh
  // bullet right below. ⏎ on an empty bullet removes it (end of the outline).
  const onBulletEnter = (id: string) => (bulletId: string) => spliceCommit(id, bulletId, true)

  // Blur a bullet: commit it (empty → remove). No new bullet on blur. Bullets
  // are always contentEditable, so a click edits in place natively — no
  // separate "enter edit mode" step needed.
  const onBulletBlur = (id: string) => (bulletId: string) => spliceCommit(id, bulletId, false)

  // ⏎ on a focused inline URL card: start a new line right after it.
  const onInsertAfter = (id: string) => (itemId: string) =>
    patchNote(id, (n) => {
      const idx = n.items.findIndex((it) => it.id === itemId)
      if (idx < 0) return n
      const fresh: NoteItem = { kind: 'bullet', id: uid('b'), origin: 'human', text: '', status: 'kept', editing: true }
      return { ...n, items: [...n.items.slice(0, idx + 1), fresh, ...n.items.slice(idx + 1)] }
    })

  // ---- accept / reject (records reaction signals that sharpen the next fire) ----
  const keepBullet = (id: string) => (bid: string) =>
    patchNote(id, (n) => {
      const b = n.items.find((x) => x.id === bid)
      return {
        ...n,
        items: n.items.map((x) => (x.id === bid && isBullet(x) ? { ...x, status: 'kept' } : x)),
        kept: b && isBullet(b) ? [...n.kept, b.text] : n.kept
      }
    })
  const rejectBullet = (id: string) => (bid: string) =>
    patchNote(id, (n) => {
      const b = n.items.find((x) => x.id === bid)
      return {
        ...n,
        items: n.items.filter((x) => x.id !== bid),
        rejected: b && isBullet(b) ? [...n.rejected, b.text] : n.rejected
      }
    })
  const keepCard = (id: string) => (cid: string) =>
    patchNote(id, (n) => {
      const c = n.items.find((x) => x.id === cid)
      return {
        ...n,
        items: n.items.map((x) => (x.id === cid && isCard(x) ? { ...x, status: 'kept' } : x)),
        kept: c && isCard(c) ? [...n.kept, c.title] : n.kept
      }
    })
  // Removes a card line. Rejecting a PENDING AI card records a reaction signal;
  // deleting a settled card (⌫ on a focused card) is just deletion.
  const removeCard = (id: string) => (cid: string) =>
    patchNote(id, (n) => {
      const c = n.items.find((x) => x.id === cid)
      const wasPending = c && isCard(c) && c.status === 'pending'
      return {
        ...n,
        items: n.items.filter((x) => x.id !== cid),
        rejected: wasPending ? [...n.rejected, c.title] : n.rejected
      }
    })

  // ---- select + drag keyword note(s); supports multi-select group move ----
  const onNotePointerDown = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation() // don't let the canvas start a marquee
    const el = e.target as HTMLElement
    const interactive = !!el.closest('input, textarea, button, .accept, .url-card, .bullet-text')

    // Shift/⌘-click toggles this note in/out of the selection (no drag).
    if (e.shiftKey || e.metaKey) {
      setSelectedIds((prev) => {
        const s = new Set(prev)
        s.has(id) ? s.delete(id) : s.add(id)
        return s
      })
      return
    }

    // Drag the whole selection if this note is part of a multi-select; else
    // select just this note and drag it.
    let dragIds: string[]
    if (selectedIdsRef.current.has(id) && selectedIdsRef.current.size > 1) {
      dragIds = [...selectedIdsRef.current]
    } else {
      dragIds = [id]
      setSelectedIds(new Set([id]))
    }
    if (interactive) return // editing a field → no drag

    const origins = dragIds
      .map((i) => notesRef.current.find((n) => n.id === i))
      .filter((n): n is KeywordNote => !!n)
      .map((n) => ({ i: n.id, ox: n.x, oy: n.y }))
    const sx = e.clientX, sy = e.clientY
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy
      setNotes((ns) =>
        ns.map((n) => {
          const o = origins.find((o) => o.i === n.id)
          return o ? { ...n, x: o.ox + dx, y: o.oy + dy } : n
        })
      )
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  // ---- Tier-3 command pill ----
  const onCommand = (command: string) => {
    const { x, y } = { x: 80, y: 60 + notes.length * 6 }
    const id = uid('n')
    // Pre-set lastFiredWords so the every-20 effect doesn't ALSO fire this note.
    setNotes((ns) => [...ns, { id, x, y, keyword: command, keywordEditing: false, items: [], aiRunning: false, kept: [], rejected: [], lastFiredWords: countWords(command) }])
    setSelectedIds(new Set([id]))
    void runAi(id, command)
  }

  return (
    <div className="window">
      <header className="titlebar">
        <span className="lights"><i className="r" /><i className="y" /><i className="g" /></span>
        <span className="folder">🗂</span>
        <span className="title">IdeaSpace brainstorming note</span>
        <div className="controls">
          <div className="seg">
            {PROVIDERS.map((p) => (
              <button key={p.id} className={provider === p.id ? 'on' : ''} onClick={() => setProvider(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          {provider === 'open' && (
            <select value={openIdx} onChange={(e) => setOpenIdx(Number(e.target.value))}>
              {OPEN_MODELS.map((m, i) => <option key={i} value={i}>{m.label}</option>)}
            </select>
          )}
          <button className={`chip ${webSearch ? 'on' : ''}`} onClick={() => setWebSearch((w) => !w)}>
            🔎 Web search {webSearch ? 'on' : 'off'}
          </button>
        </div>
      </header>

      <main>
        <Transcript recording={recording} onTranscriptChange={onTranscriptChange} />
        <div
          className="canvas"
          ref={canvasRef}
          onPointerDown={onCanvasPointerDown}
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
        >
          <div className="ai-switch" onPointerDown={(e) => e.stopPropagation()}>
            <span className="ai-switch-label">AI co-creation mode</span>
            <button
              className={`switch ${aiEnabled ? 'on' : ''}`}
              role="switch"
              aria-checked={aiEnabled}
              aria-label="AI co-creation mode"
              onClick={toggleAi}
            />
          </div>

          {notes.length === 0 && (
            <div className="canvas-hint">Select transcript text and drag here · click to start a note · drag the canvas to box-select</div>
          )}

          {marquee && (
            <div className="marquee" style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }} />
          )}

          {notes.map((n) => (
            <KeywordNoteView
              key={n.id}
              note={n}
              selected={selectedIds.has(n.id)}
              onPointerDownNote={onNotePointerDown(n.id)}
              onKeywordChange={onKeywordChange(n.id)}
              onKeywordCommit={onKeywordCommit(n.id)}
              onBulletChange={onBulletChange(n.id)}
              onBulletEnter={onBulletEnter(n.id)}
              onBulletBlur={onBulletBlur(n.id)}
              onKeepBullet={keepBullet(n.id)}
              onRejectBullet={rejectBullet(n.id)}
              onKeepCard={keepCard(n.id)}
              onRemoveCard={removeCard(n.id)}
              onInsertAfter={onInsertAfter(n.id)}
            />
          ))}

          <CommandBar
            recording={recording}
            onToggleRecord={() => setRecording((r) => !r)}
            onSubmit={onCommand}
          />
        </div>
      </main>
    </div>
  )
}
