// Observer evaluator + contributor passes, client-direct. Mirrors passes.ts:
// each composes prompt + context + transport + strict parse into the result the
// services/ wiring maps 1:1 onto. Non-streaming (contract: observer notes appear
// whole). Never throws — a lost observer evaluation costs nothing, so unlike the
// extraction pass there is NO retry: a parse failure or transport error simply
// yields a null result the engine logs as an error and moves on.

import { chatCompletion, ChatHttpError } from './chat'
import { getJsonReasoningParams, getReasoningParams } from './parse'
import { parseObserverContribution, parseObserverDecision } from './observer-parse'
import {
  buildObserverContributorSystem,
  buildObserverContributorUserText,
  buildObserverEvaluatorSystem,
  buildObserverEvaluatorUserText
} from './observer-prompts'
import type {
  ObserverContribution,
  ObserverContributorInput,
  ObserverDecision,
  ObserverEvaluatorInput
} from './observer-types'
import type { FetchLike, LlmProvider } from './types'

export interface ObserverEvaluateOutcome {
  decision: ObserverDecision | null
  serverMs: number
  model?: string
  error?: string
}

export async function observerEvaluate(
  provider: LlmProvider,
  input: ObserverEvaluatorInput,
  fetchImpl?: FetchLike
): Promise<ObserverEvaluateOutcome> {
  try {
    const { content, serverMs } = await chatCompletion(provider, {
      system: buildObserverEvaluatorSystem(),
      userText: buildObserverEvaluatorUserText(input),
      fetchImpl,
      maxTokens: 800,
      reasoning: getJsonReasoningParams(provider.model)
    })
    // Parse failure → null decision, no error: the engine skips this round.
    return { decision: parseObserverDecision(content), serverMs, model: provider.model }
  } catch (e) {
    const serverMs = e instanceof ChatHttpError ? e.serverMs : 0
    return { decision: null, serverMs, model: provider.model, error: errMsg(e) }
  }
}

export interface ObserverContributeOutcome {
  contribution: ObserverContribution | null
  serverMs: number
  model?: string
  error?: string
}

export async function observerContribute(
  provider: LlmProvider,
  input: ObserverContributorInput,
  fetchImpl?: FetchLike
): Promise<ObserverContributeOutcome> {
  try {
    const { content, serverMs } = await chatCompletion(provider, {
      system: buildObserverContributorSystem(),
      userText: buildObserverContributorUserText(input),
      fetchImpl,
      maxTokens: 1000,
      // Plain-text protocol (KEYWORD/bullets/SEARCH), not JSON — use the
      // non-JSON reasoning params like the section-header pass.
      reasoning: getReasoningParams(provider.model)
    })
    return { contribution: parseObserverContribution(content), serverMs, model: provider.model }
  } catch (e) {
    const serverMs = e instanceof ChatHttpError ? e.serverMs : 0
    return { contribution: null, serverMs, model: provider.model, error: errMsg(e) }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
