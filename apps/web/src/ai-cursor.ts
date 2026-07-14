// Pure reducer for the AI Pal cursor state machine. No Date.now(), no I/O, no
// React — time rides on every event. Returns the SAME reference when nothing
// changed so React can bail out of re-rendering.
//
// Pure AI-cursor state machine (see docs/modules/07-cothinking-agent.md).

import type {
  AiCursorState,
  AiCursorEvent,
  AiActivity
} from './ai-cursor-types'
import { AI_CURSOR_IDLE_FADE_MS } from './ai-cursor-types'

export function reduceAiCursor(
  state: AiCursorState,
  event: AiCursorEvent
): AiCursorState {
  switch (event.type) {
    case 'start': {
      const activity: AiActivity = {
        activityId: event.activityId,
        target: event.target,
        label: 'thinking',
        startedAt: event.at
      }
      const activities = { ...state.activities, [event.activityId]: activity }
      // If there's already a current activity, this one just waits (sticky —
      // no jump). It becomes current only when currentId is null.
      if (state.currentId !== null) {
        return { ...state, activities, lastActivityAt: event.at }
      }
      // No current activity → this one becomes current immediately. Covers
      // the re-appear-after-fade case: visible was false, the new activity
      // snaps target/label directly (no travel from a stale ghost).
      return {
        ...state,
        activities,
        currentId: event.activityId,
        target: event.target,
        label: 'thinking',
        lastActivityAt: event.at,
        visible: true
      }
    }

    case 'label': {
      const act = state.activities[event.activityId]
      if (!act) return state // unknown id → same reference
      const updated: AiActivity = { ...act, label: event.label }
      const activities = { ...state.activities, [event.activityId]: updated }
      if (event.activityId === state.currentId) {
        return { ...state, activities, label: event.label, lastActivityAt: event.at }
      }
      return { ...state, activities, lastActivityAt: event.at }
    }

    case 'move': {
      const act = state.activities[event.activityId]
      if (!act) return state // unknown id → same reference
      const updated: AiActivity = { ...act, target: event.target }
      const activities = { ...state.activities, [event.activityId]: updated }
      if (event.activityId === state.currentId) {
        return { ...state, activities, target: event.target, lastActivityAt: event.at }
      }
      return { ...state, activities, lastActivityAt: event.at }
    }

    case 'end': {
      const act = state.activities[event.activityId]
      if (!act) return state // unknown id → same reference
      const activities = { ...state.activities }
      delete activities[event.activityId]

      if (event.activityId !== state.currentId) {
        // A non-current activity ended: just drop it from the map.
        return { ...state, activities, lastActivityAt: event.at }
      }

      // The current activity ended → pick the FIFO survivor (smallest
      // startedAt). If none, linger: keep target/label/visible, null current.
      const survivors = Object.values(activities)
      if (survivors.length === 0) {
        return {
          ...state,
          activities,
          currentId: null,
          visible: event.linger === false ? false : state.visible,
          lastActivityAt: event.at
        }
      }
      // FIFO: smallest startedAt wins.
      const next = survivors.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b))
      return {
        ...state,
        activities,
        currentId: next.activityId,
        target: next.target,
        label: next.label,
        lastActivityAt: event.at
      }
    }

    case 'tick': {
      // Never hide while an activity is live.
      if (state.currentId !== null) return state
      // Fade only after the idle window has elapsed.
      if (state.visible && event.at - state.lastActivityAt >= AI_CURSOR_IDLE_FADE_MS) {
        return { ...state, visible: false }
      }
      return state // no-op → same reference
    }
  }
}
