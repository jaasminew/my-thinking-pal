// Browser-side AI title/description for the catalog (Lead-owned). One cheap
// call at upload time; ANY failure returns null and the caller falls back to
// filename + first-200-chars — the catalog never blocks on this.

import { chatCompletion } from '../../packages/core/llm'
import { resolveClientProvider } from '../llm/provider-config'

export const DESCRIBE_SYSTEM =
  `You write catalog metadata for a user-uploaded project file so an AI can later decide ` +
  `whether to open it. You get the filename and the beginning of its text. ` +
  `Return ONLY a JSON object of exactly this shape: ` +
  `{"title":"<3-8 word title>","description":"<one sentence, ≤30 words, stating what the file contains and is for>"}. ` +
  `Write in the language of the file's content. No prose, no markdown, no code fences.`

export type DescribeFile = (name: string, textHead: string) => Promise<{ title: string; description: string } | null>

export function parseDescription(raw: string): { title: string; description: string } | null {
  try {
    const stripped = raw.replace(/```[a-z]*\n?|```/gi, '')
    const start = stripped.indexOf('{')
    const end = stripped.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    const parsed = JSON.parse(stripped.slice(start, end + 1))
    const title = typeof parsed?.title === 'string' ? parsed.title.trim() : ''
    const description = typeof parsed?.description === 'string' ? parsed.description.trim() : ''
    if (!title || !description) return null
    return { title, description }
  } catch {
    return null
  }
}

/** Fallback catalog entry when AI is unavailable: filename + first 200 chars. */
export function fallbackDescription(name: string, text: string): { title: string; description: string } {
  return { title: name, description: text.trim().slice(0, 200) }
}

export function defaultDescribeFile(providerId?: string, model?: string): DescribeFile {
  return async (name, textHead) => {
    try {
      const provider = await resolveClientProvider(providerId, model)
      const user = `Filename: ${name}\n\nBeginning of the file:\n${textHead.slice(0, 2000)}`
      const r = await chatCompletion(provider, { system: DESCRIBE_SYSTEM, userText: user, temperature: 0, maxTokens: 200 })
      return parseDescription(r.content)
    } catch {
      return null
    }
  }
}
