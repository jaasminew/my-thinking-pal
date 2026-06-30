import type { STTProvider, STTStartOpts, TranscriptEvent } from './types'
import { PcmMicStream } from './pcm'

// Speechmatics real-time. Browser can't set WS auth headers, so the server
// mints a short-lived JWT (/api/speechmatics-token) and we pass it as ?jwt=.
// UNVERIFIED until a SPEECHMATICS_API_KEY is set — validate message shapes and
// the code-switching language config against current Speechmatics docs.
export class SpeechmaticsSTT implements STTProvider {
  readonly name = 'Speechmatics'
  private ws?: WebSocket
  private mic = new PcmMicStream()
  private cb?: (e: TranscriptEvent) => void
  private err?: (e: Error) => void

  async start(opts: STTStartOpts): Promise<void> {
    const { token, url, language } = await (await fetch('/api/speechmatics-token')).json()
    if (!token) throw new Error('No SPEECHMATICS_API_KEY in .env.')
    const audioStream = opts.stream

    const ws = new WebSocket(`${url}?jwt=${encodeURIComponent(token)}`)
    this.ws = ws

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          message: 'StartRecognition',
          audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
          transcription_config: {
            language: language || 'en',
            enable_partials: true,
            operating_point: 'enhanced'
          }
        })
      )
      this.mic.start((pcm) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(pcm)
      }, { stream: audioStream })
    }

    ws.onmessage = (m) => {
      let d: any
      try {
        d = JSON.parse(m.data)
      } catch {
        return
      }
      const text = d?.metadata?.transcript
      if (!text) return
      if (d.message === 'AddTranscript') this.cb?.({ text, isFinal: true, timestamp: performance.now() })
      else if (d.message === 'AddPartialTranscript')
        this.cb?.({ text, isFinal: false, timestamp: performance.now() })
      else if (d.message === 'Error') this.err?.(new Error('Speechmatics: ' + (d.reason || d.type)))
    }

    ws.onerror = () => this.err?.(new Error('Speechmatics WS error — check key / proxy.'))
    ws.onclose = (e) => {
      if (e.code !== 1000 && e.code !== 1005) this.err?.(new Error(`Speechmatics closed (${e.code}) ${e.reason || ''}`))
    }
  }

  stop(): void {
    this.mic.stop()
    try {
      this.ws?.send(JSON.stringify({ message: 'EndOfStream' }))
      this.ws?.close()
    } catch {
      /* noop */
    }
  }

  onTranscript(cb: (e: TranscriptEvent) => void): void {
    this.cb = cb
  }
  onError(cb: (err: Error) => void): void {
    this.err = cb
  }
}
