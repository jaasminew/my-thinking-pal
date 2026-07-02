/**
 * SHARED CONTRACT — Core domain model.
 *
 * Transport-neutral. Identical types are used by:
 *   - the web demo (Jasmine)         — implemented over HTTP/WebSocket
 *   - the Electron production app     — implemented over IPC
 *
 * The CanvasOperation log is the single source of truth for canvas state;
 * CanvasNode / HighlightSpan are projections that can always be rebuilt from
 * the log (see projection.ts).
 *
 * CHANGE DISCIPLINE: this file is a shared agreement. Do not edit it silently.
 * Any change goes through the changelog in README.md and is announced to the
 * other track before merging.
 */

export type AuthorType = 'human' | 'ai'

export type NodeSource = 'user' | 'co_create' | 'command' | 'url'

export type AgentTier = 'co_create' | 'command'

export interface Project {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface IdeaSpace {
  id: string
  projectId?: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface Session {
  id: string
  ideaSpaceId: string
  startedAt: string
  endedAt?: string
}

export interface TranscriptSegment {
  id: string
  ideaSpaceId: string
  sessionId: string
  startMs: number
  endMs: number
  text: string
  speakerId?: string
  language?: string
  /** idea-space level absolute offsets into the continuous transcript */
  absoluteStartOffset: number
  absoluteEndOffset: number
  isFinal: boolean
}

export interface HighlightSpan {
  id: string
  ideaSpaceId: string
  /** idea-space level absolute offsets; may span multiple segments */
  absoluteStartOffset: number
  absoluteEndOffset: number
  /** optional locator hint only; offsets are authoritative */
  transcriptSegmentId?: string
  score: number
  reason?: string
  createdAt: string
}

/** One line in a keyword note's outline. Human bullets are always 'kept'; AI
 * bullets arrive 'pending' until the human keeps them (✓) or rejects them (✕). */
export interface NoteBullet {
  id: string
  origin: AuthorType
  text: string
  status: 'pending' | 'kept'
  /** which AI fire produced this bullet (append-not-replace streaming) */
  fireId?: string
}

/** An AI-found inspiration card rendered inside a keyword note. */
export interface NoteCard {
  id: string
  title: string
  url: string
  snippet?: string
  image?: string
  status: 'pending' | 'kept'
}

/**
 * A free-floating "keyword note" on the canvas: an accented keyword header, a
 * bullet outline (human first, then AI), and optional inspiration cards. The
 * whole note is positioned/draggable. AI authorship lives per-bullet (origin).
 */
export interface CanvasNode {
  id: string
  ideaSpaceId: string
  authorType: AuthorType
  source: NodeSource
  x: number
  y: number
  width?: number
  height?: number
  keyword: string
  bullets: NoteBullet[]
  cards: NoteCard[]
  /** legacy single-content nodes; superseded by keyword/bullets */
  content?: string
  /** source highlight for a human-dragged node */
  sourceHighlightSpanId?: string
  /** AI nodes point back to the contribution that produced them */
  agentContributionId?: string
  createdAt: string
  updatedAt: string
}

export interface AgentTrigger {
  id: string
  ideaSpaceId: string
  tier: AgentTier
  strategy: string
  reason: string
  sourceEventIds: string[]
  createdAt: string
}

export type AgentContributionStatus = 'proposed' | 'kept' | 'ignored' | 'built_on'

export interface AgentContribution {
  id: string
  ideaSpaceId: string
  triggerId: string
  tier: AgentTier
  strategy: string
  contextSnapshotId: string
  outputNodeIds: string[]
  status: AgentContributionStatus
  createdAt: string
}

export type CanvasOperationKind =
  | 'node.create'
  | 'node.update'
  | 'node.move'
  | 'node.delete'
  | 'transcript.append'
  | 'highlight.add'

/**
 * Append-only canvas operation. The ordered log of these per idea space is the
 * authoritative state. Operations are immutable once written.
 */
export interface CanvasOperation<TPayload = unknown> {
  id: string
  ideaSpaceId: string
  /** monotonically increasing within an idea space */
  seq: number
  actor: AuthorType
  source: NodeSource
  kind: CanvasOperationKind
  payload: TPayload
  /** agent's observed context version; used to discard stale outputs */
  contextVersion?: number
  agentContributionId?: string
  createdAt: string
}

/** Operation as authored by a client (the backend assigns id/seq/createdAt). */
export type NewCanvasOperation = Pick<
  CanvasOperation,
  'ideaSpaceId' | 'actor' | 'source' | 'kind' | 'payload'
> &
  Partial<Pick<CanvasOperation, 'contextVersion' | 'agentContributionId'>>
