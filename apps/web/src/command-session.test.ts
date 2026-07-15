import { describe, expect, it } from 'vitest'
import type { KeywordNote } from './canvas-types'
import {
  applyAction,
  applySessionAction,
  buildTurnContext,
  freeCreateSpot,
  salvageLooseAction,
  spreadCreateAt,
  type CommandSession
} from './command-session'

const session = (): CommandSession => ({
  id: 'session-1',
  source: null,
  origin: 'canvas',
  title: 'Canvas request',
  messages: [],
  createdAt: 1,
  canvasRefs: [],
  createdNoteCount: 0
})

const pendingNote = (): KeywordNote => ({
  id: 'existing',
  x: 0,
  y: 0,
  keyword: 'Existing',
  keywordEditing: false,
  aiRunning: false,
  kept: [],
  rejected: [],
  lastFiredWords: 0,
  items: []
})

describe('command-session canvas ledger', () => {
  it('returns minted note/item ids and registers stable aliases', () => {
    const tracked = applyAction([], { type: 'create-note', keyword: 'Market', bullets: ['One', 'Two'] }, { x: 10, y: 20 })
    expect(tracked.created?.noteId).toBe(tracked.notes[0].id)
    expect(tracked.created?.itemIds).toEqual(tracked.notes[0].items.map((item) => item.id))

    const result = applySessionAction([], session(), { type: 'create-note', keyword: 'Market', bullets: ['One', 'Two'] }, { x: 10, y: 20 })
    expect(result.applied).toBe(true)
    expect(result.notes[0]).toMatchObject({ x: 10, y: 20, keyword: 'Market' })
    expect(result.session.canvasRefs[0].alias).toBe('n1')
    expect(result.session.canvasRefs[0].items.map((item) => item.alias)).toEqual(['n1.1', 'n1.2'])
    expect(result.session.createdNoteCount).toBe(1)
  })

  it('registers bullets appended through a note alias', () => {
    const created = applySessionAction([], session(), { type: 'create-note', keyword: 'Draft', bullets: ['First'] }, { x: 0, y: 0 })
    const appended = applySessionAction(
      created.notes,
      created.session,
      { type: 'insert-bullet', ref: 'n1', text: 'Second' },
      { x: 0, y: 0 }
    )
    expect(appended.applied).toBe(true)
    expect(appended.notes[0].items).toHaveLength(2)
    expect(appended.session.canvasRefs[0].items.map((item) => item.alias)).toEqual(['n1.1', 'n1.2'])
  })

  it('edits/removes only live pending session items and drops stale refs', () => {
    const created = applySessionAction([], session(), { type: 'create-note', keyword: 'Draft', bullets: ['First', 'Second'] }, { x: 0, y: 0 })
    const edited = applySessionAction(created.notes, created.session, { type: 'edit-bullet', ref: 'n1.1', text: 'Short' }, { x: 0, y: 0 })
    expect(edited.applied).toBe(true)
    expect((edited.notes[0].items[0] as any).text).toBe('Short')

    const keptNotes = edited.notes.map((note) => ({
      ...note,
      items: note.items.map((item, i) => i === 0 ? { ...item, status: 'kept' as const } : item)
    }))
    const keptEdit = applySessionAction(keptNotes, edited.session, { type: 'edit-bullet', ref: 'n1.1', text: 'Nope' }, { x: 0, y: 0 })
    expect(keptEdit.applied).toBe(false)

    const removed = applySessionAction(keptNotes, edited.session, { type: 'remove-item', ref: 'n1.2' }, { x: 0, y: 0 })
    expect(removed.applied).toBe(true)
    expect(removed.notes[0].items).toHaveLength(1)
    expect(applySessionAction(removed.notes, removed.session, { type: 'remove-item', ref: 'n1.2' }, { x: 0, y: 0 }).applied).toBe(false)
    expect(applySessionAction(removed.notes, removed.session, { type: 'edit-bullet', ref: 'n9.9', text: 'Nope' }, { x: 0, y: 0 }).applied).toBe(false)
  })

  it('locks note renaming once any ledger item is kept', () => {
    const created = applySessionAction([], session(), { type: 'create-note', keyword: 'Draft', bullets: ['First'] }, { x: 0, y: 0 })
    const renamed = applySessionAction(created.notes, created.session, { type: 'edit-note', ref: 'n1', keyword: 'Final draft' }, { x: 0, y: 0 })
    expect(renamed.applied).toBe(true)
    expect(renamed.notes[0].keyword).toBe('Final draft')
    const locked = renamed.notes.map((note) => ({ ...note, items: note.items.map((item) => ({ ...item, status: 'kept' as const })) }))
    expect(applySessionAction(locked, renamed.session, { type: 'edit-note', ref: 'n1', keyword: 'Nope' }, { x: 0, y: 0 }).applied).toBe(false)
  })

  it('still renames after the model removed one of its own lines', () => {
    const created = applySessionAction([], session(), { type: 'create-note', keyword: 'Draft', bullets: ['First', 'Second'] }, { x: 0, y: 0 })
    const removed = applySessionAction(created.notes, created.session, { type: 'remove-item', ref: 'n1.2' }, { x: 0, y: 0 })
    expect(removed.applied).toBe(true)
    const renamed = applySessionAction(removed.notes, removed.session, { type: 'edit-note', ref: 'n1', keyword: 'Trimmed draft' }, { x: 0, y: 0 })
    expect(renamed.applied).toBe(true)
    expect(renamed.notes[0].keyword).toBe('Trimmed draft')
  })

  it('rebuilds model context from only live pending ledger entries', () => {
    const created = applySessionAction([], session(), { type: 'create-note', keyword: 'Draft', bullets: ['Pending', 'Keep me'] }, { x: 0, y: 0 })
    const notes = created.notes.map((note) => ({
      ...note,
      items: note.items.map((item, i) => i === 1 ? { ...item, status: 'kept' as const } : item)
    }))
    const ctx = buildTurnContext(undefined, null, 'speech', created.session, notes)
    expect(ctx.sessionCanvas).toContain('[n1.1] Pending')
    expect(ctx.sessionCanvas).not.toContain('n1.2')
    expect(ctx.sessionCanvas).not.toContain('Keep me')
  })

  it('spreads five notes over a three-column grid', () => {
    const anchor = { x: 100, y: 200 }
    expect(Array.from({ length: 5 }, (_, i) => spreadCreateAt(anchor, i))).toEqual([
      { x: 100, y: 200 },
      { x: 440, y: 200 },
      { x: 780, y: 200 },
      { x: 100, y: 520 },
      { x: 440, y: 520 }
    ])
  })

  it('salvages loose actions: first bullet founds a note, later ones follow it', () => {
    const empty = session()
    const founded = salvageLooseAction(
      { type: 'insert-bullet', text: 'Design the harness loop around a verifier', apply: true },
      empty
    )
    expect(founded).toEqual({
      type: 'create-note',
      keyword: 'Design the harness loop',
      bullets: ['Design the harness loop around a verifier'],
      apply: true
    })
    // A loose card with no session note yet has no home — dropped.
    expect(salvageLooseAction({ type: 'add-card', title: 'X', url: 'https://x.dev' }, empty)).toBeNull()

    const withNote = applySessionAction([], empty, founded!, { x: 0, y: 0 })
    expect(salvageLooseAction({ type: 'insert-bullet', text: 'Second point' }, withNote.session))
      .toEqual({ type: 'insert-bullet', text: 'Second point', ref: 'n1' })
    expect(salvageLooseAction({ type: 'add-card', title: 'X', url: 'https://x.dev' }, withNote.session))
      .toEqual({ type: 'add-card', title: 'X', url: 'https://x.dev', ref: 'n1' })
    // Targeted actions and non-creation actions pass through untouched.
    expect(salvageLooseAction({ type: 'insert-bullet', text: 'T', noteId: 'real' }, withNote.session))
      .toEqual({ type: 'insert-bullet', text: 'T', noteId: 'real' })
    expect(salvageLooseAction({ type: 'remove-item', ref: 'n1.1' }, withNote.session))
      .toEqual({ type: 'remove-item', ref: 'n1.1' })
  })

  it('skips grid slots already occupied by live notes', () => {
    const anchor = { x: 0, y: 0 }
    expect(freeCreateSpot(anchor, [])).toEqual({ x: 0, y: 0 })
    const atSlot0 = { ...pendingNote(), x: 0, y: 0 }
    const atSlot1 = { ...pendingNote(), id: 'existing-2', x: 340, y: 0 }
    expect(freeCreateSpot(anchor, [atSlot0])).toEqual({ x: 340, y: 0 })
    expect(freeCreateSpot(anchor, [atSlot0, atSlot1])).toEqual({ x: 680, y: 0 })
    // An off-grid note near a slot still blocks it (real footprints, not slots).
    const offGrid = { ...pendingNote(), id: 'existing-3', x: 180, y: -40 }
    expect(freeCreateSpot(anchor, [offGrid])).toEqual({ x: 680, y: 0 })
  })

  it('does not append to missing real notes', () => {
    const result = applySessionAction([pendingNote()], session(), { type: 'insert-bullet', noteId: 'missing', text: 'Nope' }, { x: 0, y: 0 })
    expect(result.applied).toBe(false)
  })
})
