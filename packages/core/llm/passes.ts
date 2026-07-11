// High-level "text -> text" passes, client-direct. Each composes prompts +
// context + transport + parse into the result shape the app already expects,
// so the services/ wiring layer maps 1:1 onto these. No backend involved.

import { chatCompletion, ChatHttpError } from './chat'
import { buildExtractSignalsSystem, buildOrganizeSystem, SECTION_HEADER_SYSTEM } from './prompts'
import { buildExtractSignalsUserText } from './context'
import { cleanSectionHeader, getJsonReasoningParams, getReasoningParams, parseOrganize, parseSignals } from './parse'
import { makeLinkStripper, makeProtocolFilter } from './filters'
import { streamOpenModel, type SearchIntent } from './stream'
import type { ExtractedSignal, FetchLike, LlmProvider, OrganizeSection, UrlCard } from './types'

// ---- Signal extraction ------------------------------------------------------
export interface ExtractSignalsInput {
  systemPrompt: string
  rawText: string
  existingSignals?: string
}
export interface ExtractSignalsOutcome {
  signals: ExtractedSignal[]
  skipped?: boolean
  serverMs: number
  model?: string
  error?: string
}

export async function extractSignals(
  provider: LlmProvider,
  input: ExtractSignalsInput,
  fetchImpl?: FetchLike
): Promise<ExtractSignalsOutcome> {
  const system = buildExtractSignalsSystem(input.systemPrompt)
  const userText = buildExtractSignalsUserText(input.rawText, input.existingSignals)
  try {
    const { content, serverMs } = await chatCompletion(provider, {
      system,
      userText,
      fetchImpl,
      maxTokens: 3000,
      reasoning: getJsonReasoningParams(provider.model)
    })
    const signals = parseSignals(content)
    if (signals === null) return { signals: [], skipped: true, serverMs, model: provider.model }
    return { signals, serverMs, model: provider.model }
  } catch (e) {
    // Any transport/HTTP failure → retry case (engine puts the raw back).
    const serverMs = e instanceof ChatHttpError ? e.serverMs : 0
    return { signals: [], skipped: true, serverMs, error: errMsg(e) }
  }
}

// ---- Organize ---------------------------------------------------------------
export interface OrganizeInput {
  lines: string
  closing?: boolean
}
export interface OrganizeOutcome {
  sections: OrganizeSection[]
  serverMs: number
  model?: string
  error?: string
}

export async function organize(
  provider: LlmProvider,
  input: OrganizeInput,
  fetchImpl?: FetchLike
): Promise<OrganizeOutcome> {
  try {
    const { content, serverMs } = await chatCompletion(provider, {
      system: buildOrganizeSystem(!!input.closing),
      userText: String(input.lines).slice(0, 8000),
      fetchImpl,
      maxTokens: 3000,
      reasoning: getJsonReasoningParams(provider.model)
    })
    return { sections: parseOrganize(content), serverMs, model: provider.model }
  } catch (e) {
    // Empty sections → engine treats as "no organize this round" (never errors).
    const serverMs = e instanceof ChatHttpError ? e.serverMs : 0
    return { sections: [], serverMs, error: errMsg(e) }
  }
}

// ---- Section header ---------------------------------------------------------
export interface SectionHeaderOutcome {
  header: string
  serverMs: number
  model?: string
  error?: string
}

export async function sectionHeader(
  provider: LlmProvider,
  body: string,
  fetchImpl?: FetchLike
): Promise<SectionHeaderOutcome> {
  try {
    const { content, serverMs } = await chatCompletion(provider, {
      system: SECTION_HEADER_SYSTEM,
      userText: String(body).replace(/==/g, '').slice(0, 1200),
      fetchImpl,
      maxTokens: 40,
      reasoning: getReasoningParams(provider.model)
    })
    return { header: cleanSectionHeader(content), serverMs, model: provider.model }
  } catch (e) {
    const serverMs = e instanceof ChatHttpError ? e.serverMs : 0
    return { header: '', serverMs, error: errMsg(e) }
  }
}

// ---- Co-creation (streaming) ------------------------------------------------
export interface CocreateHandlers {
  onText: (text: string) => void
  onDiagnosis?: (text: string) => void
  onAnchor?: (line: number) => void
  onUrl?: (u: UrlCard) => void
  onInlineImage?: (im: { title: string; url: string; line: number }) => void
}
export interface CocreateOutcome {
  searchIntent?: SearchIntent
  passed: boolean
  contentLines: number
  model?: string
  error?: string
}

// Runs the streamed diagnose-then-contribute pass: streamOpenModel → protocol
// filter (DIAGNOSIS/ANCHOR/PASS) → link stripper (cards/inline images). Web
// search + og:image resolution stay in the caller (they need user-configured
// search + network policy), driven by the returned searchIntent.
export async function cocreateStream(
  provider: LlmProvider,
  input: { system: string; userText: string; images?: string[] },
  handlers: CocreateHandlers,
  fetchImpl?: FetchLike,
  signal?: AbortSignal
): Promise<CocreateOutcome> {
  const strip = makeLinkStripper(
    (t) => handlers.onText(t),
    (u) => handlers.onUrl?.(u),
    (im) => handlers.onInlineImage?.({ ...im, line: Math.max(0, proto.contentLines - 1) })
  )
  const proto = makeProtocolFilter(
    (l) => strip.push(l),
    (d) => handlers.onDiagnosis?.(d),
    (a) => handlers.onAnchor?.(a)
  )
  try {
    const searchIntent = await streamOpenModel(provider, {
      system: input.system,
      userText: input.userText,
      images: input.images,
      onText: (t) => proto.push(t),
      fetchImpl,
      signal
    })
    proto.flush()
    strip.flush()
    return {
      searchIntent: proto.passed ? undefined : searchIntent,
      passed: proto.passed,
      contentLines: proto.contentLines,
      model: provider.model
    }
  } catch (e) {
    proto.flush()
    strip.flush()
    return { passed: proto.passed, contentLines: proto.contentLines, error: errMsg(e) }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
