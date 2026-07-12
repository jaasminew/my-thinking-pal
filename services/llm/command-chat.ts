import type { CommandChatRequest, CommandChatResult, CommandChatAction, CommandChatSource } from './command-chat-types'
import {
  COMMAND_CHAT_SYSTEM,
  buildCommandChatPrompt,
  formatProjectInstructions,
  makeCommandActionFilter,
  prependMemoryBlock,
  streamOpenModel,
  type FetchLike,
  type LlmProvider
} from '../../packages/core/llm'
import { resolveClientProvider } from './provider-config'
import { resolveOgImage, searchWeb } from './web-search'
import { runLocalCommandChat, type LocalRuntime } from './local-runtime'

export interface CommandChatHandlers {
  /** Streamed chat text delta — append to the live assistant message. */
  onText: (text: string) => void
  /** A proposed canvas action — render as a button, never auto-apply. */
  onAction?: (action: CommandChatAction) => void
  /** A validated uploaded-file or web-search source used by the response. */
  onSource?: (source: CommandChatSource) => void
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
  const isLocalRuntime = providerId === 'codex' || providerId === 'claude-code' || providerId === 'cursor'
  let provider: LlmProvider | undefined
  if (!isLocalRuntime) {
    try {
      provider = deps?.provider ?? (await resolveClientProvider(providerId, req.model))
    } catch (e: any) {
      return { error: e?.message || String(e) }
    }
  }

  const sourceNoteId = typeof req.context?.sourceNoteId === 'string' ? req.context.sourceNoteId : undefined
  const webResults = req.webSearch && req.projectMemory?.webSearchQuery
    ? await searchWeb(req.projectMemory.webSearchQuery, 3, doFetch)
    : []
  const knowledgeSources = [
    ...(req.projectMemory?.files ?? []).map((f) => ({ id: f.id, title: f.title })),
    ...(req.projectMemory?.images ?? []).map((f) => ({ id: f.id, title: f.title }))
  ]
  const sourceCatalog = [
    ...(knowledgeSources.length
      ? [`Selected knowledge sources (cite by id if used):\n${knowledgeSources.map((s) => `- id: ${s.id}\n  title: ${s.title}`).join('\n')}`]
      : []),
    ...(webResults.length
      ? [`Web-search results (cite by exact URL if used):\n${webResults.map((s) => `- title: ${s.title}\n  url: ${s.url}${s.snippet ? `\n  snippet: ${s.snippet}` : ''}`).join('\n')}`]
      : [])
  ].join('\n\n')
  // Project Memory (M3): instructions after the base system; memory block atop
  // the prompt, before selected text / note / transcript.
  const system = COMMAND_CHAT_SYSTEM + formatProjectInstructions(req.projectInstructions)
  const prompt = [sourceCatalog, buildCommandChatPrompt(req.messages, req.context)].filter(Boolean).join('\n\n')
  const userText = prependMemoryBlock(prompt, req.projectMemory?.block)

  let actionCount = 0
  // append-image actions defer until after the stream (need og:image resolved).
  const pendingImages: { caption: string; url: string; title?: string }[] = []
  const emittedSourceKeys = new Set<string>()

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

  const handleSourceJson = (raw: string) => {
    let source: any
    try {
      source = JSON.parse(raw)
    } catch {
      return
    }
    if (source?.kind === 'knowledge' && typeof source.id === 'string') {
      const known = knowledgeSources.find((s) => s.id === source.id)
      if (!known || emittedSourceKeys.has(`knowledge:${known.id}`)) return
      emittedSourceKeys.add(`knowledge:${known.id}`)
      handlers.onSource?.({ kind: 'knowledge', id: known.id, title: known.title })
      return
    }
    if (source?.kind === 'web' && typeof source.url === 'string') {
      const known = webResults.find((s) => s.url === source.url)
      if (!known || emittedSourceKeys.has(`web:${known.url}`)) return
      emittedSourceKeys.add(`web:${known.url}`)
      handlers.onSource?.({ kind: 'web', title: known.title, url: known.url })
    }
  }

  const filter = makeCommandActionFilter((t) => handlers.onText(t), handleActionJson, handleSourceJson)

  if (isLocalRuntime) {
    const local = await runLocalCommandChat(
      {
        runtime: providerId as LocalRuntime,
        command: req.runtimeCommand,
        model: req.model,
        system,
        userText
      },
      { onText: (t) => filter.push(t), onAction: handleActionJson, onSource: handleSourceJson },
      doFetch as typeof fetch,
      signal
    )
    filter.flush()
    if (local.aborted) return { aborted: true }
    if (local.error) return { error: local.error, provider: req.provider }
  } else {
    try {
      await streamOpenModel(
        provider!,
        {
          system,
          userText,
          // Selected memory images ride as multimodal parts.
          images: req.projectMemory?.images?.map((im) => im.dataUrl),
          onText: (t) => filter.push(t),
          fetchImpl: doFetch,
          signal
        }
      )
      filter.flush()
    } catch (e: any) {
      filter.flush()
      if (e?.name === 'AbortError' || signal?.aborted) return { aborted: true }
      return { error: e?.message || String(e), provider: req.provider }
    }
  }

  if (signal?.aborted) return { aborted: true }

  // Some otherwise-capable models occasionally ignore the hidden SOURCE
  // protocol. Never lose the provenance we actually supplied: when the model
  // emitted no source lines, show the selected knowledge/search reference set.
  if (!emittedSourceKeys.size) {
    for (const source of knowledgeSources) {
      emittedSourceKeys.add(`knowledge:${source.id}`)
      handlers.onSource?.({ kind: 'knowledge', id: source.id, title: source.title })
    }
    for (const source of webResults) {
      emittedSourceKeys.add(`web:${source.url}`)
      handlers.onSource?.({ kind: 'web', title: source.title, url: source.url })
    }
  }

  // Resolve deferred images: og:image → append-image action; else a link card
  // (so the reference is never lost).
  for (const im of pendingImages) {
    if (!sourceNoteId) break
    const src = await resolveOgImage(im.url, doFetch)
    if (src) handlers.onAction?.({ type: 'append-image', noteId: sourceNoteId, src, sourceUrl: im.url, title: im.title, caption: im.caption })
    else handlers.onAction?.({ type: 'add-card', noteId: sourceNoteId, title: im.title || im.caption, url: im.url })
  }

  return { model: provider?.model ?? req.model, provider: req.provider }
}
