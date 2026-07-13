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
    const { content, serverMs, finishReason, hasReasoningContent } = await chatCompletion(provider, {
      system: buildObserverEvaluatorSystem(),
      userText: buildObserverEvaluatorUserText(input),
      fetchImpl,
      maxTokens: 3000,
      reasoning: getJsonReasoningParams(provider.model)
    })
    const decision = parseObserverDecision(content)
    if (!decision) {
      // Keep this diagnostic at the parse boundary: the network panel does not
      // make provider reasoning-vs-answer starvation obvious. Never print the
      // prompt or credentials.
      console.warn('[observer] unparseable evaluator response', {
        content,
        finish_reason: finishReason ?? null,
        reasoning_content_present: hasReasoningContent
      })
      const metadata = [
        finishReason ? `finish_reason=${finishReason}` : '',
        `reasoning_content=${hasReasoningContent ? 'present' : 'absent'}`
      ].filter(Boolean).join(', ')
      return {
        decision: null,
        serverMs,
        model: provider.model,
        error: `unparseable-response (${metadata})`
      }
    }
    return { decision, serverMs, model: provider.model }
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
    const { content, serverMs, finishReason, hasReasoningContent } = await chatCompletion(provider, {
      system: buildObserverContributorSystem(),
      userText: buildObserverContributorUserText(input),
      fetchImpl,
      maxTokens: 3000,
      // Plain-text protocol (KEYWORD/bullets/SEARCH), not JSON — use the
      // non-JSON reasoning params like the section-header pass.
      reasoning: getReasoningParams(provider.model)
    })
    const contribution = parseObserverContribution(content)
    if (!contribution) {
      console.warn('[observer] unparseable contributor response', {
        content,
        finish_reason: finishReason ?? null,
        reasoning_content_present: hasReasoningContent
      })
      const metadata = [
        finishReason ? `finish_reason=${finishReason}` : '',
        `reasoning_content=${hasReasoningContent ? 'present' : 'absent'}`
      ].filter(Boolean).join(', ')
      return {
        contribution: null,
        serverMs,
        model: provider.model,
        error: `unparseable-response (${metadata})`
      }
    }
    return { contribution, serverMs, model: provider.model }
  } catch (e) {
    const serverMs = e instanceof ChatHttpError ? e.serverMs : 0
    return { contribution: null, serverMs, model: provider.model, error: errMsg(e) }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
