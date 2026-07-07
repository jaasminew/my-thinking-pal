import type { CommandChatRequest, CommandChatResult, CommandChatAction } from './command-chat-types'
import {
  COMMAND_CHAT_SYSTEM,
  buildCommandChatPrompt,
  makeCommandActionFilter,
  streamOpenModel,
  type FetchLike,
  type LlmProvider
} from '../../packages/core/llm'
import { resolveClientProvider } from './provider-config'
import { resolveOgImage } from './web-search'

export interface CommandChatHandlers {
  /** Streamed chat text delta — append to the live assistant message. */
  onText: (text: string) => void
  /** A proposed canvas action — render as a button, never auto-apply. */
  onAction?: (action: CommandChatAction) => void
}

export interface CommandChatDeps {
  provider?: LlmProvider
  fetchImpl?: FetchLike
}

// Tier-3 command-chat, CLIENT-DIRECT. The model streams straight from the user's
// provider; ACTION protocol lines are parsed out client-side (as the server used
// to) and validated before becoming buttons. append-image resolves its og:image
// through the minimal backend relay. Stateless: the caller replays full history.
export async function requestCommandChat(
  req: CommandChatRequest,
  handlers: CommandChatHandlers,
  signal?: AbortSignal,
  deps?: CommandChatDeps
): Promise<CommandChatResult> {
  if (!Array.isArray(req.messages) || !req.messages.length) return { error: 'messages[] is required' }

  const doFetch = deps?.fetchImpl ?? fetch
  const providerId = req.provider === 'open' ? req.openSub ?? 'groq' : req.provider
  let provider: LlmProvider
  try {
    provider = deps?.provider ?? (await resolveClientProvider(providerId, req.model))
  } catch (e: any) {
    return { error: e?.message || String(e) }
  }

  const sourceNoteId = typeof req.context?.sourceNoteId === 'string' ? req.context.sourceNoteId : undefined
  const userText = buildCommandChatPrompt(req.messages, req.context)

  let actionCount = 0
  // append-image actions defer until after the stream (need og:image resolved).
  const pendingImages: { caption: string; url: string; title?: string }[] = []

  const handleActionJson = (raw: string) => {
    if (actionCount >= 6) return
    let a: any
    try {
      a = JSON.parse(raw)
    } catch {
      return // malformed protocol line — never shown to the user
    }
    if (a?.type === 'insert-bullet' && sourceNoteId && typeof a.text === 'string' && a.text.trim()) {
      actionCount++
      handlers.onAction?.({ type: 'insert-bullet', noteId: sourceNoteId, text: a.text.trim() })
    } else if (
      a?.type === 'add-card' &&
      sourceNoteId &&
      typeof a.title === 'string' &&
      typeof a.url === 'string' &&
      /^https?:\/\//.test(a.url)
    ) {
      actionCount++
      handlers.onAction?.({
        type: 'add-card',
        noteId: sourceNoteId,
        title: a.title,
        url: a.url,
        snippet: typeof a.snippet === 'string' ? a.snippet : undefined
      })
    } else if (
      a?.type === 'append-image' &&
      sourceNoteId &&
      typeof a.caption === 'string' &&
      typeof a.url === 'string' &&
      /^https?:\/\//.test(a.url)
    ) {
      actionCount++
      pendingImages.push({ caption: a.caption, url: a.url, title: typeof a.title === 'string' ? a.title : undefined })
    } else if (a?.type === 'create-note' && typeof a.keyword === 'string' && a.keyword.trim() && Array.isArray(a.bullets)) {
      actionCount++
      handlers.onAction?.({
        type: 'create-note',
        keyword: a.keyword.trim(),
        bullets: a.bullets.filter((b: any) => typeof b === 'string' && b.trim())
      })
    }
  }

  const filter = makeCommandActionFilter((t) => handlers.onText(t), handleActionJson)

  try {
    await streamOpenModel(
      provider,
      { system: COMMAND_CHAT_SYSTEM, userText, onText: (t) => filter.push(t), fetchImpl: doFetch, signal }
    )
    filter.flush()
  } catch (e: any) {
    filter.flush()
    if (e?.name === 'AbortError' || signal?.aborted) return { aborted: true }
    return { error: e?.message || String(e), provider: req.provider }
  }

  if (signal?.aborted) return { aborted: true }

  // Resolve deferred images: og:image → append-image action; else a link card
  // (so the reference is never lost).
  for (const im of pendingImages) {
    if (!sourceNoteId) break
    const src = await resolveOgImage(im.url, doFetch)
    if (src) handlers.onAction?.({ type: 'append-image', noteId: sourceNoteId, src, sourceUrl: im.url, title: im.title, caption: im.caption })
    else handlers.onAction?.({ type: 'add-card', noteId: sourceNoteId, title: im.title || im.caption, url: im.url })
  }

  return { model: provider.model, provider: req.provider }
}
