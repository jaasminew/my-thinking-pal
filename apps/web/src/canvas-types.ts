import type { ObserverOpportunityType } from '../../../packages/core/llm/observer-types'

// A free-floating "keyword note" on the canvas. Internally an outline: a keyword
// header and ONE ordered sequence of items — text bullets and URL cards — so a
// card is an inline line in the flow (arrow keys walk onto it, Enter continues
// below it), not an appendix at the bottom. The whole note is draggable.
export type Origin = 'human' | 'ai'
export type MediaType = 'image' | 'gif' | 'video'

export interface TextStyleRun {
  start: number
  end: number
  color?: string
  size?: number
  weight?: 400 | 600 | 700
}

export interface BulletItem {
  kind: 'bullet'
  id: string
  origin: Origin
  text: string
  status: 'pending' | 'kept' // pending = AI awaiting ✓/✕; kept = settled (human is always kept)
  editing?: boolean // "focus me": set on freshly created bullets; orthogonal to status
  fireId?: string // which AI increment produced this bullet (for append-not-replace)
  fireLine?: number // 0-based position within its fire (a fire may stream several bullets)
  /**
   * The model's INVISIBLE self-diagnosis for the fire that produced this bullet
   * ("bullet 3 claims X with no evidence — needs a real case"). Never rendered;
   * folded into kept/rejected so reactions carry WHY the suggestion was offered.
   */
  diagnosis?: string
  /**
   * Inline image, PART OF the bullet (no ✓/✕ of its own — it lives and dies
   * with its text). src is the cited page's own og:image, resolved server-side.
   */
  image?: { src: string; sourceUrl?: string; title?: string; mediaType?: MediaType; w?: number; offsetX?: number; offsetY?: number }
  indent?: number // outline depth (0 = top level); Tab/Shift+Tab moves it. Cards never indent.
  /** Body lines are plain by default; this opt-in renders the line as a list item. */
  bulleted?: boolean
  /** Sparse character ranges carrying rich-text presentation. Plain text stays canonical. */
  runs?: TextStyleRun[]
}

export interface CardItem {
  kind: 'card'
  id: string
  title: string
  url: string
  snippet?: string
  image?: string
  origin: Origin // ai = found by a fire; human = URL typed/pasted into a bullet
  status: 'pending' | 'kept'
  /** Same invisible fire diagnosis as BulletItem.diagnosis (AI cards only). */
  diagnosis?: string
}

// A picture the user dropped/pasted INTO a note. A first-class line item (like a
// url card, not glued to a bullet's text): the caret can land on it, Enter opens
// a line after it, Backspace deletes it. Rendered in the AI inline-image style.
export interface ImageItem {
  kind: 'image'
  id: string
  src: string // data URL (dropped/pasted file) or remote url
  /** Missing on older saved boards and treated as a still image. */
  mediaType?: MediaType
  /** The image's single attached destination URL. */
  sourceUrl?: string
  title?: string
  w?: number
  /** Visual offset within the note, used to keep the opposite resize anchor fixed. */
  offsetX?: number
  offsetY?: number
  origin: Origin
  status: 'pending' | 'kept'
}

export type NoteItem = BulletItem | CardItem | ImageItem

// A free-floating picture ON the canvas (dropped onto blank space) — NOT wrapped
// in a note, so it has no keyword header. Draggable/selectable/deletable like a
// note; shares the canvas selection set, so its id must be globally unique.
export interface CanvasImage {
  id: string
  x: number
  y: number
  src: string
  /** Missing on older saved boards and treated as a still image. */
  mediaType?: MediaType
  w?: number // natural display width in world coordinates (set once the image loads)
  /** Exactly one attached URL; absent means the image is unlinked. */
  url?: string
}

export interface KeywordNote {
  id: string
  x: number
  y: number
  keyword: string
  keywordEditing: boolean
  items: NoteItem[]
  aiRunning: boolean
  // Reaction memory + the human word count at which the AI last fired.
  kept: string[]
  rejected: string[]
  lastFiredWords: number
  /**
   * When the note's keyword was SPOKEN — set only on notes created by dragging
   * a transcript phrase. Anchors every AI fire on this note to the ±1min
   * verbatim transcript window around that moment (rule B, overrides the
   * rolling 2min window). Typed/command notes have none.
   */
  originTs?: number
  /**
   * The exact phrase dragged out of the transcript, kept immutable (unlike
   * `keyword`, which the user may later edit). Lets the transcript re-find and
   * faintly mark its source text, and link a hover back to this note.
   */
  sourceText?: string
  /**
   * The signal type ('decision', 'objection', …) of the transcript line the
   * dragged phrase came from — recorded, never rendered; passed to co-creation
   * as seedType so the model knows what KIND of thought seeded this note.
   */
  originSignalType?: string
  /**
   * Present ONLY on notes the observer agent created (not human notes, not
   * reactive co-creation). Hidden metadata — never rendered — recording WHY the
   * observer emitted: the opportunity kind, the evaluator's reason, and its
   * self-reported confidence. Survives reload/sync so post-session triage and
   * later log replay can attribute the note. Its presence also marks the note as
   * observer-originated for any visual distinction.
   */
  observerMeta?: {
    opportunityType: ObserverOpportunityType
    reason?: string
    confidence: number
  }
}

export const isBullet = (i: NoteItem): i is BulletItem => i.kind === 'bullet'
export const isCard = (i: NoteItem): i is CardItem => i.kind === 'card'
export const isImage = (i: NoteItem): i is ImageItem => i.kind === 'image'

// Ids end up in localStorage (notes, tree nodes), so they must stay unique
// ACROSS sessions too — a bare counter restarts at 1 on every page load and
// collides with saved ids. A per-session random seed makes each run distinct.
let _id = 0
const _seed = Math.random().toString(36).slice(2, 6)
export const uid = (p: string) => `${p}_${_seed}${++_id}`
