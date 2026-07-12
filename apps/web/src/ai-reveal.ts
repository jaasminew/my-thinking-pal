// RevealScheduler — content-agnostic paced replayer for the AI cursor's
// one-at-a-time reveal. Pure plumbing: it never inspects what an event means.
// No React, no DOM, no I/O. Timers are injectable so tests drive time.
//
// See AI_CURSOR_PLAN.md §6 for the full behavioral contract.

import type { RevealScheduler, BufferedFireEvent } from './ai-cursor-types'
import { AI_REVEAL_CHUNK_MS, AI_REVEAL_MAX_DRAIN_MS } from './ai-cursor-types'

export function createRevealScheduler(opts?: {
  chunkMs?: number
  maxDrainMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}): RevealScheduler {
  const chunkMs = opts?.chunkMs ?? AI_REVEAL_CHUNK_MS
  const maxDrainMs = opts?.maxDrainMs ?? AI_REVEAL_MAX_DRAIN_MS
  const setTimeoutFn = opts?.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = opts?.clearTimeoutFn ?? clearTimeout

  // Internal state.
  let queue: BufferedFireEvent[] = []
  let live = false
  let finished = false
  let cancelled = false
  let apply: ((e: BufferedFireEvent) => void) | null = null
  let done: (() => void) | null = null
  let doneFired = false
  let timer: ReturnType<typeof setTimeoutFn> | null = null
  // Fixed interval computed once when the drain starts (at goLive), so the
  // whole initial backlog lands within maxDrainMs. Events pushed during the
  // drain reuse the same interval — they never jump ahead.
  let drainInterval = chunkMs

  // Compute the drain interval for a backlog of `n` events: chunkMs each,
  // unless that exceeds maxDrainMs, in which case compress so the backlog
  // fits within maxDrainMs.
  function computeInterval(n: number): number {
    if (n * chunkMs > maxDrainMs) {
      return Math.max(1, Math.floor(maxDrainMs / n))
    }
    return chunkMs
  }

  // Fire the done() callback exactly once, when the queue is empty AND finish()
  // has been called. Only fires after goLive (when `done` is set). Called after
  // every apply and after finish().
  function maybeDone() {
    if (cancelled) return
    if (doneFired) return
    if (!live) return // goLive not called yet — done callback isn't set
    if (queue.length === 0 && finished) {
      doneFired = true
      done?.()
    }
  }

  // Drain one event from the queue, then schedule the next.
  function drain() {
    if (cancelled) return
    if (queue.length === 0) {
      timer = null
      maybeDone()
      return
    }
    const e = queue.shift()!
    apply?.(e)
    if (cancelled) return // apply may have called cancel
    if (queue.length > 0) {
      // Reuse the fixed drain interval (computed at goLive start) so the
      // whole backlog lands within maxDrainMs.
      timer = setTimeoutFn(drain, drainInterval)
    } else {
      timer = null
      maybeDone()
    }
  }

  return {
    push(e: BufferedFireEvent) {
      if (cancelled) return
      if (!live) {
        // Buffering phase — just queue.
        queue.push(e)
        return
      }
      // Live phase.
      if (queue.length === 0 && timer === null) {
        // Queue empty and nothing scheduled → pass through synchronously.
        apply?.(e)
        maybeDone()
      } else {
        // A drain is in flight → append; it'll be picked up in order.
        queue.push(e)
      }
    },

    goLive(applyFn: (e: BufferedFireEvent) => void, doneFn: () => void) {
      if (cancelled) return
      if (live) return // double goLive is a no-op (must not throw)
      live = true
      apply = applyFn
      done = doneFn
      if (queue.length === 0) {
        // Nothing buffered — done() fires if already finished, else waits.
        maybeDone()
        return
      }
      // Compute the fixed drain interval for the initial backlog so it lands
      // within maxDrainMs.
      drainInterval = computeInterval(queue.length)
      // Start the drain. The first event fires after one interval.
      timer = setTimeoutFn(drain, drainInterval)
    },

    finish() {
      if (cancelled) return
      finished = true
      maybeDone()
    },

    cancel() {
      if (cancelled) return
      cancelled = true
      queue = []
      if (timer !== null) {
        clearTimeoutFn(timer)
        timer = null
      }
      apply = null
      done = null
    },

    isLive() {
      return live && !cancelled
    }
  }
}
