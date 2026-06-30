import type { STTProvider, STTStartOpts, TranscriptEvent } from './types'

// Realistic-latency STT: real mic -> Deepgram streaming WS. Dormant until a
// DEEPGRAM_API_KEY is set in .env (the browser fetches it from /api/deepgram-key).
// Verify model/encoding params against current Deepgram docs when you wire a key.
export class DeepgramSTT implements STTProvider {
  readonly name = 'Deepgram'
  private ws?: WebSocket
  private mr?: MediaRecorder
  private stream?: MediaStream
  private cb?: (e: TranscriptEvent) => void
  private err?: (e: Error) => void

  async start(opts: STTStartOpts): Promise<void> {
    const { key } = await (await fetch('/api/deepgram-key')).json()
    if (!key) throw new Error('No DEEPGRAM_API_KEY in .env — add one or use WebSpeech.')

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })

    const params = new URLSearchParams({
      model: 'nova-2',
      interim_results: 'true',
      smart_format: 'true',
      language: (opts.lang || 'en-US').startsWith('zh') ? 'zh' : 'en-US'
    })
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', key])

    ws.onopen = () => {
      const mr = new MediaRecorder(this.stream!, { mimeType: 'audio/webm' })
      mr.ondataavailable = (e) => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(e.data)
      }
      mr.start(250) // ship audio every 250ms
      this.mr = mr
    }

    ws.onmessage = (m) => {
      const d = JSON.parse(m.data)
      const alt = d?.channel?.alternatives?.[0]
      const text = alt?.transcript
      if (!text) return
      this.cb?.({ text, isFinal: !!d.is_final, timestamp: performance.now() })
    }

    ws.onerror = () => this.err?.(new Error('Deepgram WS error'))
    this.ws = ws
  }

  stop(): void {
    try {
      this.mr?.stop()
    } catch {
      /* noop */
    }
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
    this.stream?.getTracks().forEach((t) => t.stop())
  }

  onTranscript(cb: (e: TranscriptEvent) => void): void {
    this.cb = cb
  }
  onError(cb: (err: Error) => void): void {
    this.err = cb
  }
}
