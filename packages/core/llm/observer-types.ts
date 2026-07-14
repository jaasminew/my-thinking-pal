// ============================================================================
// CONTRACTS FROZEN — do not edit.
// Observer feature types (see docs/modules/07-cothinking-agent.md).
// Every observer task — Lead's and Implementer's — implements these shapes
// exactly. If a type or signature you need is missing, STOP and ask the Lead;
// do not invent one here or anywhere else.
// ============================================================================

import type { UrlCard } from './types'

// ---- Model categories --------------------------------------------------------

/**
 * The app exposes exactly two user-facing model choices:
 * 'listener' — speech-side, values speed: signal extraction, transcript
 *              organize, observer evaluator, Project Memory Stage-A selection.
 *              Web providers only (never CLI runtimes).
 * 'thinker'  — quality-side: co-creation, commands, observer contributor.
 *              Any provider, CLI runtimes included.
 * Both default to DEFAULT_BASE_MODEL (Groq gpt-oss-120b, see contract §4);
 * a user-assigned model per category overrides the default when usable.
 */
export type ModelCategory = 'listener' | 'thinker'

// ---- Decision (evaluator output) -------------------------------------------

export type ObserverOpportunityType =
  | 'missing-angle'
  | 'connection'
  | 'comparison'
  | 'risk'
  | 'example'
  | 'question'
  | 'source'

export interface ObserverDecision {
  emit: boolean
  /** Model self-report. Logged for replay analysis ONLY — never a runtime gate. */
  confidence: number
  /** Present when emit is true. */
  opportunityType?: ObserverOpportunityType
  topic?: string
  reason?: string
  needsResearch?: boolean
  suggestedSearchQuery?: string
}

// ---- Signals (engine input, mirrors SignalEngine Line) ----------------------

export interface ObserverSignal {
  text: string
  /** SignalType string ('decision' | 'objection' | 'judgment' | 'example'). */
  type?: string
  speaker?: string
  ts: number
}

// ---- Evaluator / contributor inputs -----------------------------------------

export interface ObserverEvaluatorInput {
  /** The fresh signal batch that triggered this evaluation. */
  signals: ObserverSignal[]
  /** Verbatim transcript, last ~5 minutes. */
  transcriptWindow?: string
  /** Existing canvas: note titles + settled (kept) content, condensed. */
  canvasSummary: string
  /** Topics of recent observer emissions (primary duplicate defense). */
  recentObserverTopics: string[]
  kept: string[]
  rejected: string[]
  /** 'zh' | 'en' | other BCP-47-ish tag; evaluator/contributor match it. */
  dominantLanguage?: string
}

export interface ObserverContributorInput {
  decision: ObserverDecision
  signals: ObserverSignal[]
  transcriptWindow?: string
  canvasSummary: string
  dominantLanguage?: string
}

// ---- Contribution (contributor output) --------------------------------------

/** Raw parsed contributor output (core layer — before any search runs). */
export interface ObserverContribution {
  keyword: string
  /** 1-3 concise bullets. */
  bullets: string[]
  /** Parsed from a trailing `SEARCH: <query>` line, when present. */
  searchQuery?: string
}

export type SearchPath = 'cli-native' | 'relay' | 'none'

/** Contribution after the services layer resolved the search path. */
export interface ObserverContributionResult {
  keyword: string
  bullets: string[]
  /** 0-3 source cards from the resolved search path. Never fabricated. */
  sources: UrlCard[]
  searchPath: SearchPath
  model?: string
  error?: string
}

// ---- Engine state, config, logging ------------------------------------------

export interface ObserverState {
  lastEvaluatedSignalTs: number
  lastEmittedAt?: number
  /** Normalized topics of recent emissions, capped at maxRecentTopics. */
  recentTopics: string[]
  consecutiveRejected: number
  postSessionIgnored: number
}

export interface ObserverEngineConfig {
  /** Minimum ms between emissions AND between evaluator calls. Default 75_000. */
  cooldownMs: number
  /** Cap on ObserverState.recentTopics. Default 8. */
  maxRecentTopics: number
}

export type ObserverOutcome = 'kept' | 'rejected' | 'post-session-ignored'

export type ObserverGate =
  | 'disabled'
  | 'not-running'
  | 'empty-batch'
  | 'already-evaluated'
  | 'evaluating'
  | 'cooldown'
  | 'cocreate-in-flight'
  | 'duplicate-title'
  | 'stale-generation'
  /** Logged by app wiring (not the engine) when no Listener model is usable. */
  | 'listener-unavailable'

export interface ObserverLogRecord {
  ts: number
  kind: 'evaluation' | 'emission' | 'skip' | 'error'
  /** Which deterministic gate blocked, for kind 'skip'. */
  gate?: ObserverGate
  decision?: ObserverDecision
  /** [first, last] ts of the evaluated signal batch. */
  signalTsRange?: [number, number]
  model?: string
  latencyMs?: number
  searchPath?: SearchPath
  /** Source cards actually attached to this emission (0 = search ran but found
   *  nothing, or no query was issued). Distinguishes "relay called" from
   *  "relay merely selected" — searchPath alone is misleading. */
  sourceCount?: number
  outcome?: ObserverOutcome
  error?: string
}

// ---- Engine dependency seams (injected; engine stays pure of I/O) -----------

export interface ObserverCanvasContext {
  noteTitles: string[]
  /** Condensed kept content of existing notes. */
  settledContent: string
  kept: string[]
  rejected: string[]
  /** URLs already on the canvas (source-card dedup). */
  existingUrls: string[]
  dominantLanguage?: string
  transcriptWindow?: string
}

export interface ObserverEngineDeps {
  evaluate(input: ObserverEvaluatorInput): Promise<ObserverDecision | ObserverEvaluationFailure | null>
  contribute(input: ObserverContributorInput): Promise<ObserverContributionResult | null>
  getContext(): ObserverCanvasContext
  /** True while a reactive co-creation fire is streaming (in-flight guard). */
  isCocreateStreaming(): boolean
  /** Test seam. Defaults to Date.now. */
  now?(): number
}

/** A failed evaluator round with the reason preserved for the engine log. */
export interface ObserverEvaluationFailure {
  decision: null
  error: string
  model?: string
}

export interface ObserverEmission {
  decision: ObserverDecision
  result: ObserverContributionResult
  signalTsRange: [number, number]
}
