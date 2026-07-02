/**
 * SHARED CONTRACT — Transport-neutral backend interface.
 *
 * This is the seam between UI and system. It replaces the Electron-only
 * `window.app` / IPC surface with an interface that BOTH tracks implement over
 * their own transport:
 *
 *   - Web demo (Jasmine):    class WebBackend implements Backend  — fetch + WebSocket
 *   - Electron app (partner): class IpcBackend implements Backend — preload bridge
 *
 * UI code imports `Backend` and never knows which transport is underneath.
 * That is the whole point: the interaction patterns Jasmine validates against
 * `Backend` in the web demo run unchanged on the Electron implementation.
 *
 * Mapping guidance (non-binding, per track):
 *   ideaSpace.*  -> REST:      POST /idea-spaces, GET /idea-spaces/:id, GET /idea-spaces
 *   canvas.*     -> REST:      POST /idea-spaces/:id/operations, GET .../operations
 *   agent.*      -> REST:      POST /idea-spaces/:id/agent/command
 *   stt.*        -> WebSocket: audio frames up, SttEvent-shaped messages down
 *   subscribe()  -> WebSocket / SSE: PipelineEvent stream, filtered by topic
 */

import type {
  AgentContribution,
  CanvasOperation,
  HighlightSpan,
  IdeaSpace,
  NewCanvasOperation,
  TranscriptSegment
} from './domain'

// ---------------------------------------------------------------------------
// Pipeline events (the live push channel)
// ---------------------------------------------------------------------------

/**
 * Topics are subscribed to individually so the hot path (transcript display) is
 * never blocked behind cold-path data (agent contributions).
 */
export const PipelineTopic = {
  TranscriptPartial: 'transcript.partial',
  TranscriptFinalized: 'transcript.segment.finalized',
  AmbientHighlight: 'ambient.highlight.created',
  AgentContribution: 'agent.contribution',
  CanvasOperation: 'canvas.operation'
} as const

export type PipelineTopic = (typeof PipelineTopic)[keyof typeof PipelineTopic]

export interface TranscriptPartialEvent {
  ideaSpaceId: string
  sessionId: string
  text: string
}

/** The payload carried by each topic. Keep these in lockstep across tracks. */
export interface PipelineEventMap {
  [PipelineTopic.TranscriptPartial]: TranscriptPartialEvent
  [PipelineTopic.TranscriptFinalized]: TranscriptSegment
  [PipelineTopic.AmbientHighlight]: HighlightSpan
  [PipelineTopic.AgentContribution]: AgentContribution
  [PipelineTopic.CanvasOperation]: CanvasOperation
}

// ---------------------------------------------------------------------------
// The backend surface UI depends on
// ---------------------------------------------------------------------------

export interface Backend {
  ideaSpace: {
    create(input?: { title?: string; projectId?: string }): Promise<IdeaSpace>
    open(id: string): Promise<{ ideaSpace: IdeaSpace; operations: CanvasOperation[] }>
    list(): Promise<IdeaSpace[]>
  }

  canvas: {
    /** Author a new operation; the backend assigns id/seq/createdAt and echoes it back. */
    appendOperation(op: NewCanvasOperation): Promise<CanvasOperation>
    listOperations(ideaSpaceId: string): Promise<CanvasOperation[]>
  }

  agent: {
    /** Tier-3: an explicit command typed into a keyword note. Result arrives via
     *  the AgentContribution / CanvasOperation topics, not the return value. */
    sendCommand(input: {
      ideaSpaceId: string
      noteId: string
      command: string
      transcriptWindow?: string
    }): Promise<void>
  }

  stt: {
    /** Begin a live speech session for an idea space. */
    start(ideaSpaceId: string): Promise<{ sessionId: string }>
    /** Push a frame of 16kHz/16-bit mono PCM audio. */
    pushAudio(chunk: ArrayBuffer): void
    stop(): Promise<void>
  }

  pipeline: {
    /** Subscribe to a single topic. Returns an unsubscribe function. */
    subscribe<T extends PipelineTopic>(
      topic: T,
      handler: (payload: PipelineEventMap[T]) => void
    ): () => void
  }
}
