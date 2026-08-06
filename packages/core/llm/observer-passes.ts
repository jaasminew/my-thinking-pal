// Observer evaluator + contributor passes, client-direct. Mirrors passes.ts:
// each composes prompt + context + transport + strict parse into the result the
// services/ wiring maps 1:1 onto. Non-streaming (contract: observer notes appear
// whole). Never throws — a lost observer evaluation costs nothing, so unlike the
// extraction pass there is NO retry: a parse failure or transport error simply
// yields a null result the engine logs as an error and moves on.

import { chatCompletion, ChatHttpError } from './chat'
import { getJsonReasoningParams, getObserverMaxTokens, getReasoningParams } from './parse'
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
      maxTokens: getObserverMaxTokens(provider.model),
      reasoning: getJsonReasoningParams(provider.model)
    })
    const decision = parseObserverDecision(content)
    if (!decision) {
      // Keep this diagnostic at the parse boundary: the network panel does not
      // make provider reasoning-vs-answer starvation obvious. Never print the
      // prompt or credentials.
      const error = describeFailure(content, finishReason, hasReasoningContent)
      console.warn(`[observer] evaluator ${error}`, {
        content,
        finish_reason: finishReason ?? null,
        reasoning_content_present: hasReasoningContent,
        model: provider.model
      })
      return { decision: null, serverMs, model: provider.model, error }
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
      maxTokens: getObserverMaxTokens(provider.model),
      // Plain-text protocol (KEYWORD/bullets/SEARCH), not JSON — use the
      // non-JSON reasoning params like the section-header pass.
      reasoning: getReasoningParams(provider.model)
    })
    const contribution = parseObserverContribution(content)
    if (!contribution) {
      const error = describeFailure(content, finishReason, hasReasoningContent)
      console.warn(`[observer] contributor ${error}`, {
        content,
        finish_reason: finishReason ?? null,
        reasoning_content_present: hasReasoningContent,
        model: provider.model
      })
      return { contribution: null, serverMs, model: provider.model, error }
    }
    return { contribution, serverMs, model: provider.model }
  } catch (e) {
    const serverMs = e instanceof ChatHttpError ? e.serverMs : 0
    return { contribution: null, serverMs, model: provider.model, error: errMsg(e) }
  }
}

// Name what actually went wrong. An EMPTY completion that stopped on `length`
// is not a malformed reply: the model spent the whole token budget reasoning
// and never began the answer. The two need opposite fixes — a prompt the model
// can follow vs. a budget it can finish inside — so the engine log must not
// collapse them into one "unparseable".
function describeFailure(content: string, finishReason?: string, hasReasoningContent?: boolean): string {
  const metadata = [
    finishReason ? `finish_reason=${finishReason}` : '',
    `reasoning_content=${hasReasoningContent ? 'present' : 'absent'}`
  ].filter(Boolean).join(', ')
  const starved = !content.trim() && finishReason === 'length'
  return `${starved ? 'starved-response' : 'unparseable-response'} (${metadata})`
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
