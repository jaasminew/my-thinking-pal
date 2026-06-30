import type { STTProvider, STTStartOpts, TranscriptEvent } from './types'
import { PcmMicStream } from './pcm'

// EXPERIMENTAL — combined transcript + ambient highlight in ONE model stream,
// to A/B against the two-stage (specialized STT + text LLM) pipeline.
//
// Gemini Live takes raw audio and emits text. We instruct it to transcribe
// verbatim and wrap key phrases in «guillemets»; the client strips the markers
// for the transcript and treats the wrapped spans as highlights. Because one
// generative model does both, the transcript is only as fast/verbatim as the
// model — that latency/quality tradeoff is exactly what this experiment surfaces.
//
// Needs GEMINI_API_KEY in .env. Verify the Live model id against current docs.
export class GeminiLiveSTT implements STTProvider {
  readonly name = 'Gemini'
  /** Set by the UI before start() — folded into the model's instruction. */
  systemPrompt = ''
  private ws?: WebSocket
  private mic = new PcmMicStream()
  private buffer = ''
  private combinedCb?: (transcript: string, phrases: string[], isFinal: boolean) => void
  private err?: (err: Error) => void

  async start(opts: STTStartOpts): Promise<void> {
    const { key, model } = await (await fetch('/api/gemini-key')).json()
    if (!key) throw new Error('No GEMINI_API_KEY in .env.')
    const audioStream = opts.stream

    const ws = new WebSocket(
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`
    )
    this.ws = ws

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${model || 'gemini-2.0-flash-live-001'}`,
            generationConfig: { responseModalities: ['TEXT'] },
            systemInstruction: { parts: [{ text: this.buildInstruction() }] }
          }
        })
      )
      this.mic.start(
        (pcm) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: toBase64(pcm) }] }
              })
            )
          }
        },
        { stream: audioStream }
      )
    }

    ws.onmessage = async (m) => {
      const raw = typeof m.data === 'string' ? m.data : await (m.data as Blob).text()
      let d: any
      try {
        d = JSON.parse(raw)
      } catch {
        return
      }
      const parts = d?.serverContent?.modelTurn?.parts
      if (Array.isArray(parts)) {
        for (const p of parts) if (p.text) this.buffer += p.text
        this.emit(false)
      }
      if (d?.serverContent?.turnComplete) this.emit(true)
    }

    ws.onerror = () => this.err?.(new Error('Gemini Live WS error — check key / proxy.'))
    ws.onclose = (e) => {
      if (e.code !== 1000 && e.code !== 1005) this.err?.(new Error(`Gemini Live closed (${e.code}) ${e.reason || ''}`))
    }
  }

  private buildInstruction(): string {
    return (
      `You transcribe a live meeting/brainstorm in real time. Output ONLY the verbatim transcript ` +
      `of what is spoken, in whatever language is spoken (Chinese, English, or mixed). Do not answer, ` +
      `comment, or translate. Wrap ONLY the few phrases that carry the core idea in «guillemets». ` +
      this.systemPrompt
    )
  }

  private emit(isFinal: boolean) {
    const phrases: string[] = []
    const re = /«([^»]+)»/g
    let mt: RegExpExecArray | null
    while ((mt = re.exec(this.buffer))) phrases.push(mt[1].trim())
    const transcript = this.buffer.replace(/[«»]/g, '')
    this.combinedCb?.(transcript, phrases, isFinal)
  }

  /** Combined-mode output: full transcript + current highlight phrases. */
  onCombined(cb: (transcript: string, phrases: string[], isFinal: boolean) => void): void {
    this.combinedCb = cb
  }

  stop(): void {
    this.mic.stop()
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
    this.buffer = ''
  }

  // STTProvider interface — transcript flows through onCombined instead, but
  // these satisfy the contract so the adapter is interchangeable.
  onTranscript(_cb: (e: TranscriptEvent) => void): void {}
  onError(cb: (err: Error) => void): void {
    this.err = cb
  }
}

function toBase64(buf: ArrayBuffer): string {
  let bin = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
