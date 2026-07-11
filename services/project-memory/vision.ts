// Browser-side vision pass for IMAGE uploads (Part C, Lead-owned). One call at
// upload time against the user's own provider: it produces catalog metadata
// (title + description) AND the OCR text stored as the image's searchable
// text — so Stage-A can decide when the image matters. The pixels themselves
// are re-attached at call time (retrieve.releaseImages), never stored in text.
//
// ANY failure (no vision support, network, parse) returns null and the caller
// falls back to filename-only metadata — an image upload never blocks on this.

import { chatCompletion } from '../../packages/core/llm'
import { resolveClientProvider } from '../llm/provider-config'

export const VISION_DESCRIBE_SYSTEM =
  `You catalog a user-uploaded image so an AI can later decide whether to open it. ` +
  `Return ONLY a JSON object of exactly this shape: ` +
  `{"title":"<3-8 word title>","description":"<one sentence, ≤30 words, what the image shows and is for>",` +
  `"ocrText":"<ALL readable text in the image, verbatim, empty string if none>"}. ` +
  `Write title/description in the language of the image's content. ` +
  `No prose, no markdown, no code fences.`

export type ImageDescription = { title: string; description: string; ocrText: string }
export type DescribeImage = (name: string, dataUrl: string) => Promise<ImageDescription | null>

export function parseImageDescription(raw: string): ImageDescription | null {
  try {
    const stripped = raw.replace(/```[a-z]*\n?|```/gi, '')
    const start = stripped.indexOf('{')
    const end = stripped.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    const parsed = JSON.parse(stripped.slice(start, end + 1))
    const title = typeof parsed?.title === 'string' ? parsed.title.trim() : ''
    const description = typeof parsed?.description === 'string' ? parsed.description.trim() : ''
    const ocrText = typeof parsed?.ocrText === 'string' ? parsed.ocrText.trim() : ''
    if (!title || !description) return null
    return { title, description, ocrText }
  } catch {
    return null
  }
}

/** Fallback catalog entry when the vision call fails: filename, no OCR. */
export function fallbackImageDescription(name: string): ImageDescription {
  return { title: name, description: 'Image file (no AI description available)', ocrText: '' }
}

export function defaultDescribeImage(providerId?: string, model?: string): DescribeImage {
  return async (name, dataUrl) => {
    try {
      const provider = await resolveClientProvider(providerId, model)
      const r = await chatCompletion(provider, {
        system: VISION_DESCRIBE_SYSTEM,
        userText: `Filename: ${name}\n\nCatalog the attached image now.`,
        images: [dataUrl],
        temperature: 0,
        maxTokens: 1200
      })
      return parseImageDescription(r.content)
    } catch {
      return null
    }
  }
}

/** Browser Blob → data URL (FileReader keeps memory flat vs. manual base64). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}
