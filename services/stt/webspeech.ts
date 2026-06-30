import type { STTProvider, STTStartOpts, TranscriptEvent } from './types'

// Browser-native STT. Zero key, real mic, runs today. Chrome only.
// The mic is captured by the SpeechRecognition engine itself — this is real
// real-time microphone transcription, not file playback.
export class WebSpeechSTT implements STTProvider {
  readonly name = 'WebSpeech'
  private rec: any
  private running = false
  private cb?: (e: TranscriptEvent) => void
  private err?: (e: Error) => void
  private restartTimer?: number
  // The current un-finalized hypothesis. WebSpeech discards this when it
  // self-restarts on a pause — which is why words appear then vanish. We hold
  // it here so we can promote it to permanent text before any restart/stop.
  private pendingInterim = ''

  async start(opts: STTStartOpts): Promise<void> {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) throw new Error('WebSpeech not supported in this browser — use Chrome.')

    const rec = new SR()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = opts.lang || 'en-US'

    rec.onresult = (ev: any) => {
      let interim = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i]
        if (r.isFinal) {
          this.pendingInterim = '' // this hypothesis just became permanent
          this.cb?.({ text: r[0].transcript, isFinal: true, timestamp: performance.now() })
        } else {
          interim += r[0].transcript
        }
      }
      if (interim) {
        this.pendingInterim = interim
        this.cb?.({ text: interim, isFinal: false, timestamp: performance.now() })
      }
    }

    rec.onerror = (e: any) => {
      // 'no-speech' / 'aborted' are routine; surface the rest.
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.err?.(new Error('WebSpeech: ' + e.error))
      }
    }

    rec.onstart = () => console.log('[WebSpeech] started')

    // continuous recognition stops itself periodically; restart while running.
    // Restart must be deferred — a synchronous rec.start() here throws
    // InvalidStateError and the engine dies for good.
    rec.onend = () => {
      console.log('[WebSpeech] ended')
      this.flushPending() // don't lose the mid-phrase hypothesis across restart
      if (this.running) this.scheduleRestart()
    }

    this.rec = rec
    this.running = true
    rec.start()
  }

  private scheduleRestart(): void {
    clearTimeout(this.restartTimer)
    this.restartTimer = window.setTimeout(() => {
      if (!this.running) return
      try {
        this.rec.start()
      } catch (e) {
        console.warn('[WebSpeech] restart failed, retrying', e)
        this.scheduleRestart() // keep trying until the engine accepts it
      }
    }, 300)
  }

  stop(): void {
    this.running = false
    clearTimeout(this.restartTimer)
    this.flushPending()
    try {
      this.rec?.stop()
    } catch {
      /* noop */
    }
  }

  // Promote any un-finalized hypothesis to permanent text so it survives a
  // restart/stop instead of being silently dropped.
  private flushPending(): void {
    if (this.pendingInterim) {
      this.cb?.({ text: this.pendingInterim, isFinal: true, timestamp: performance.now() })
      this.pendingInterim = ''
    }
  }

  onTranscript(cb: (e: TranscriptEvent) => void): void {
    this.cb = cb
  }
  onError(cb: (err: Error) => void): void {
    this.err = cb
  }
}
