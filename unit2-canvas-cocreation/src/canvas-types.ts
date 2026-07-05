// A free-floating "keyword note" on the canvas. Internally an outline: a keyword
// header and ONE ordered sequence of items — text bullets and URL cards — so a
// card is an inline line in the flow (arrow keys walk onto it, Enter continues
// below it), not an appendix at the bottom. The whole note is draggable.
export type Origin = 'human' | 'ai'

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
  image?: { src: string; sourceUrl?: string; title?: string }
  indent?: number // outline depth (0 = top level); Tab/Shift+Tab moves it. Cards never indent.
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
  sourceUrl?: string // where it came from (shown in the expanded previewer)
  title?: string
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
  w?: number // natural display width in world units (set once the image loads)
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
