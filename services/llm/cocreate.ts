import type { CocreateRequest, CocreateResult, UrlCard } from './cocreate-types'
import {
  COCREATE_SYSTEM,
  COMMAND_SYSTEM,
  SEARCH_INSTRUCTION,
  buildCocreateContext,
  buildCommandContext,
  cocreateStream,
  type FetchLike,
  type LlmProvider
} from '../../packages/core/llm'
import { resolveClientProvider } from './provider-config'
import { resolveOgImage, searchWeb } from './web-search'
import { runLocalCocreate, type LocalRuntime } from './local-runtime'

export interface CocreateHandlers {
  /** Called for every streamed text delta (render it live on the canvas). */
  onText: (text: string) => void
  /** Called once when web-search inspiration URLs arrive. */
  onUrls?: (urls: UrlCard[]) => void
  /** Model's invisible self-diagnosis of what the note needs (before any text). */
  onDiagnosis?: (text: string) => void
  /** Index of the user bullet this fire anchors to (before any text). */
  onAnchor?: (line: number) => void
  /** A bullet's inline image resolved (words+image register). */
  onImage?: (img: { src: string; sourceUrl?: string; title?: string; line?: number }) => void
}

// Test seam: the app calls with (req, handlers, signal); tests inject a mock
// provider + fetch so nothing hits the network or needs a key.
export interface CocreateDeps {
  provider?: LlmProvider
  fetchImpl?: FetchLike
}

// Tier-2 co-creation / Tier-3 command, now CLIENT-DIRECT: the model streams
// straight from the user's MaaS provider (docs module 08). Web search + og:image
// (the parts a browser can't do) are resolved through the minimal backend relay.
// The request/result contract is unchanged, so App.tsx is untouched.
export async function requestCocreate(
  req: CocreateRequest,
  handlers: CocreateHandlers,
  signal?: AbortSignal,
  deps?: CocreateDeps
): Promise<CocreateResult> {
  const doFetch = deps?.fetchImpl ?? fetch
  const isCommand = typeof req.command === 'string' && req.command.trim().length > 0
  if (!isCommand && (!req.seedText || typeof req.seedText !== 'string')) {
    return { error: 'seedText or command is required' }
  }

  const baseSystem = isCommand ? COMMAND_SYSTEM : COCREATE_SYSTEM
  const system = baseSystem + (req.webSearch ? SEARCH_INSTRUCTION : '')
  const userText = isCommand
    ? buildCommandContext(req.command!, req.contextNotes, req.transcriptWindow, req.signalWindow)
    : buildCocreateContext(
        req.seedText,
        req.contextNotes,
        req.transcriptWindow,
        { kept: req.kept, rejected: req.rejected, existingIdeas: req.existingIdeas },
        req.signalWindow,
        req.seedType
      )

  const providerId = req.provider === 'open' ? req.openSub ?? 'groq' : req.provider
  const isLocalRuntime = providerId === 'codex' || providerId === 'claude-code' || providerId === 'cursor'
  let provider: LlmProvider | undefined
  if (!isLocalRuntime) {
    try {
      provider = deps?.provider ?? (await resolveClientProvider(providerId, req.model))
    } catch (e: any) {
      return { error: e?.message || String(e) }
    }
  }

  const collectedUrls: UrlCard[] = []
  // Inline images the model cited via markdown image syntax — resolved after the
  // stream (need og:image); capped at 1, matching the old server behavior.
  const inlineImageReqs: { title: string; url: string; line: number }[] = []

  const localHandlers = {
    onText: handlers.onText,
    onDiagnosis: handlers.onDiagnosis,
    onAnchor: handlers.onAnchor,
    onUrl: (u: UrlCard) => {
      // A link the model deliberately cited in a bullet → card. App enriches
      // its og:image/snippet via its own /api/url-meta effect.
      if (!collectedUrls.some((c) => c.url === u.url)) collectedUrls.push(u)
    },
    onInlineImage: (im: { title: string; url: string; line: number }) => {
      if (!inlineImageReqs.length) inlineImageReqs.push(im)
    }
  }

  const outcome = isLocalRuntime
    ? await runLocalCocreate(
        { runtime: providerId as LocalRuntime, command: req.runtimeCommand, model: req.model, system, userText },
        localHandlers,
        doFetch as typeof fetch,
        signal
      )
    : await cocreateStream(
        provider!,
        { system, userText },
        localHandlers,
        doFetch,
        signal
      )

  if (signal?.aborted) return { aborted: true }
  if (outcome.error) return { error: outcome.error, provider: req.provider, model: provider?.model ?? req.model }

  // Emit cited-link cards (if any) first.
  if (collectedUrls.length) handlers.onUrls?.(collectedUrls.slice(0, 3))

  // Resolve a model-cited inline image, degrading to a link card on no image.
  for (const im of inlineImageReqs) {
    const src = await resolveOgImage(im.url, doFetch)
    if (src) handlers.onImage?.({ src, sourceUrl: im.url, title: im.title, line: im.line })
    else {
      const card: UrlCard = { title: im.title, url: im.url }
      collectedUrls.push(card)
      handlers.onUrls?.([card])
    }
  }

  // Web search: only when the model chose a register needing it and didn't PASS.
  if (req.webSearch && outcome.searchIntent && !outcome.passed) {
    const results = await searchWeb(outcome.searchIntent.query, 1, doFetch)
    const u = results[0]
    if (u) {
      if (outcome.searchIntent.image) {
        const src = await resolveOgImage(u.url, doFetch)
        if (src) handlers.onImage?.({ src, sourceUrl: u.url, title: u.title, line: Math.max(0, outcome.contentLines - 1) })
        else {
          collectedUrls.push(u)
          handlers.onUrls?.([u])
        }
      } else {
        collectedUrls.push(u)
        handlers.onUrls?.([u])
      }
    }
  }

  return { model: provider?.model ?? req.model, provider: req.provider, urls: collectedUrls }
}
