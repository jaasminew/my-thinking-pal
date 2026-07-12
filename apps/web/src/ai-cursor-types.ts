import type { UrlCard } from '../../../services/llm/cocreate-types'

/** Status label shown in the pill next to the cursor. */
export type AiCursorLabel = 'thinking' | 'writing' | 'found sources'

/** A point in CANVAS WORLD coordinates (same space as KeywordNote.x/y). */
export interface WorldPoint {
  x: number
  y: number
}

/**
 * One in-flight AI activity the cursor could point at. activityId is the
 * co-creation fireId, or `obs_<n>` for an observer contribution. target is
 * where the cursor sits for this activity (world coords, already offset to
 * "below the note" by the caller).
 */
export interface AiActivity {
  activityId: string
  target: WorldPoint
  label: AiCursorLabel
  startedAt: number
}

/**
 * Cursor state. `activities` holds every live activity by id. `currentId` is
 * the one the cursor follows AND the reveal gate — only its content is
 * applied to the canvas. `target`/`label` mirror the current activity (or the
 * lingering last one). `lastActivityAt` drives the 2-min fade. `visible` is
 * what the overlay reads.
 */
export interface AiCursorState {
  activities: Record<string, AiActivity>
  currentId: string | null
  target: WorldPoint | null
  label: AiCursorLabel
  lastActivityAt: number
  visible: boolean
}

export const AI_CURSOR_IDLE_FADE_MS = 120_000 // 2-min linger, then fade
export const AI_CURSOR_NAME = 'AI pal'
export const AI_REVEAL_CHUNK_MS = 120        // pacing between drained events
export const AI_REVEAL_MAX_DRAIN_MS = 2_000  // cap: long backlog drains faster

/** Events the app feeds the reducer. All carry `at` (Date.now()). */
export type AiCursorEvent =
  | { type: 'start'; activityId: string; target: WorldPoint; at: number }
  | { type: 'label'; activityId: string; label: AiCursorLabel; at: number }
  | { type: 'move'; activityId: string; target: WorldPoint; at: number }
  | { type: 'end'; activityId: string; at: number; linger?: boolean }
  | { type: 'tick'; at: number }

export const initialAiCursorState: AiCursorState = {
  activities: {},
  currentId: null,
  target: null,
  label: 'thinking',
  lastActivityAt: 0,
  visible: false
}

// ---- Reveal buffering ----

/** A buffered stream event, mirroring the cocreate callbacks 1:1. */
export type BufferedFireEvent =
  | { kind: 'diagnosis'; text: string }
  | { kind: 'anchor'; line: number }
  | { kind: 'text'; chunk: string }
  | { kind: 'urls'; urls: UrlCard[] }
  | { kind: 'image'; src: string; sourceUrl?: string; title?: string; line?: number }

/**
 * Per-activity buffer + paced replayer. While not live, push() queues events.
 * goLive(apply, done) drains the queue IN ORDER, paced, then passes further
 * pushes through live. done() fires exactly once, after the queue drains AND
 * finish() has been called (either order). cancel() drops everything and
 * stops timers; apply/done are never called after cancel().
 */
export interface RevealScheduler {
  push(e: BufferedFireEvent): void
  goLive(apply: (e: BufferedFireEvent) => void, done: () => void): void
  finish(): void
  cancel(): void
  isLive(): boolean
}
