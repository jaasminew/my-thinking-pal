import type { STTProvider, STTStartOpts, SttStatusEvent, TranscriptEvent } from './types'
import { devSonioxKey } from './soniox-key'

// Real-time multilingual STT with code-switching (中英混说). Soniox auto-detects
// language per token and handles Chinese+English in one utterance — which
// WebSpeech (single language) and Deepgram (weak Mandarin) cannot.
//
// This is the LOCAL, browser-direct fallback: it pulls the key from the dev-only
// compile-time inject (see soniox-key.ts / dev-keys.ts). When signed in the app
// uses the backend `/stt` proxy (BackendSTT) instead, so this never runs then.
// Streams raw 16kHz PCM16 over WebSocket. Verify the model id against current
// Soniox docs if the connection is rejected.
export class SonioxSTT implements STTProvider {
  readonly name = 'Soniox'
  private ws?: WebSocket
  private ctx?: AudioContext
  private processor?: ScriptProcessorNode
  private source?: MediaStreamAudioSourceNode
  private stream?: MediaStream
  private cb?: (e: TranscriptEvent) => void
  private err?: (e: Error) => void
  private statusCb?: (status: SttStatusEvent) => void
  private levelCb?: (level: number) => void
  private stopping = false
  private reconnectAttempts = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private audioConnected = false
  private key = ''
  private model = ''
  /** Device rate, read once at start — see PcmMicStream: the audio callback
   * can outlive teardown, so it must not dereference a torn-down context. */
  private sourceRate = 48000
  private readonly TARGET_RATE = 16000

  async start(opts: STTStartOpts): Promise<void> {
    const credentials = devSonioxKey()
    if (!credentials.key) {
      throw new Error(
        'No Soniox key available. Sign in to use backend STT, or run `npm run dev` with SONIOX_API_KEY in .env for the local browser-direct path.'
      )
    }
    this.key = credentials.key
    this.model = credentials.model
    this.stopping = false
    this.statusCb?.({ state: 'connecting' })

    this.stream = opts.stream ?? (await navigator.mediaDevices.getUserMedia({ audio: true }))
    this.ctx = new AudioContext()
    this.sourceRate = this.ctx.sampleRate
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1)

    this.connectSocket()
  }

  private connectSocket(): void {
    const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket')
    this.ws = ws
    let opened = false
    const connectTimer = setTimeout(() => {
      if (opened || this.stopping || this.ws !== ws) return
      this.fail(new Error('Soniox connection timed out'))
      this.stopping = true
      ws.close()
    }, 10_000)

    ws.onopen = () => {
      if (this.stopping || this.ws !== ws) return
      opened = true
      clearTimeout(connectTimer)
      this.reconnectAttempts = 0
      this.statusCb?.({ state: 'live' })
      // First frame is the JSON config; language_hints + auto-detection enable
      // mixed Chinese/English in a single stream.
      ws.send(
        JSON.stringify({
          api_key: this.key,
          model: this.model || 'stt-rt-v5',
          audio_format: 'pcm_s16le',
          sample_rate: this.TARGET_RATE,
          num_channels: 1,
          enable_language_identification: true,
          language_hints: ['en', 'zh'],
          // Meetings are multi-speaker: tag tokens per speaker so downstream
          // signal extraction can attribute decisions/objections.
          enable_speaker_diarization: true
        })
      )

      // Pump downsampled PCM16 once the socket is live.
      this.processor!.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0)
        this.levelCb?.(rms(input))
        const active = this.ws
        if (!active || active.readyState !== WebSocket.OPEN) return
        const pcm = floatToPcm16(downsample(input, this.sourceRate, this.TARGET_RATE))
        active.send(pcm)
      }
      if (!this.sourceConnected()) {
        this.source!.connect(this.processor!)
        this.processor!.connect(this.ctx!.destination)
        this.audioConnected = true
      }
    }

    ws.onmessage = (m) => {
      let data: any
      try {
        data = JSON.parse(m.data)
      } catch {
        return
      }
      // Soniox reports auth/billing/config problems in-band, not via WS close.
      if (data?.error_code) {
        this.fail(new Error(`Soniox ${data.error_code}: ${data.error_message || data.error_type}`))
        ws.close()
        return
      }
      const tokens = data?.tokens
      if (!Array.isArray(tokens) || tokens.length === 0) return

      // Newly-final tokens -> permanent chunks, one event per speaker run (so a
      // turn change mid-batch is not glued into one chunk); the rest -> interim.
      const ts = performance.now()
      const finals = tokens.filter((t: any) => t.is_final)
      let run = ''
      let runSpeaker: string | undefined
      let runLanguage: string | undefined
      const flushRun = () => {
        if (run.trim()) {
          this.cb?.({ text: run, isFinal: true, timestamp: ts, speaker: runSpeaker, language: runLanguage })
        }
        run = ''
        runLanguage = undefined
      }
      for (const t of finals) {
        const spk = t.speaker != null && t.speaker !== '' ? `S${t.speaker}` : undefined
        if (run && spk !== runSpeaker) flushRun()
        runSpeaker = spk
        if (!runLanguage && t.language) runLanguage = t.language
        run += t.text
      }
      flushRun()
      const interim = tokens.filter((t: any) => !t.is_final)
      const interimText = interim.map((t: any) => t.text).join('')
      const interimLanguage = interim.find((t: any) => t.language)?.language
      if (interimText.trim()) this.cb?.({ text: interimText, isFinal: false, timestamp: ts, language: interimLanguage })
    }

    ws.onerror = () => {
      // onclose owns retry/error delivery so a failed connection is reported once.
    }
    ws.onclose = (e) => {
      clearTimeout(connectTimer)
      console.log('[Soniox] WS closed', e.code, e.reason)
      if (this.stopping || this.ws !== ws || e.code === 1000 || e.code === 1005) return
      // Config/auth/account rejections are not made healthier by reconnecting.
      if (e.reason && /auth|key|quota|billing|credit|account/i.test(e.reason)) {
        this.fail(new Error(`Soniox closed (${e.code}): ${e.reason}`))
        return
      }
      if (this.reconnectAttempts >= 3) {
        this.fail(new Error(`Soniox connection lost${e.reason ? `: ${e.reason}` : ''}`))
        return
      }
      const attempt = ++this.reconnectAttempts
      this.statusCb?.({ state: 'reconnecting' })
      this.reconnectTimer = setTimeout(() => {
        if (!this.stopping) this.connectSocket()
      }, Math.min(500 * 2 ** (attempt - 1), 4000))
    }
  }

  stop(): void {
    this.stopping = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.processor) this.processor.onaudioprocess = null
    try {
      this.processor?.disconnect()
      this.source?.disconnect()
    } catch {
      /* noop */
    }
    try {
      this.ctx?.close()
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
  onStatus(cb: (status: SttStatusEvent) => void): void {
    this.statusCb = cb
  }
  onAudioLevel(cb: (level: number) => void): void {
    this.levelCb = cb
  }

  private sourceConnected(): boolean {
    return this.audioConnected
  }

  private fail(error: Error): void {
    this.statusCb?.({ state: 'error', detail: error.message })
    this.err?.(error)
  }
}

// Naive linear downsample from the AudioContext rate (usually 48kHz) to 16kHz.
function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (toRate >= fromRate) return input
  const ratio = fromRate / toRate
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    out[i] = input[Math.floor(i * ratio)]
  }
  return out
}

function floatToPcm16(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}

function rms(input: Float32Array): number {
  if (!input.length) return 0
  let sum = 0
  for (const sample of input) sum += sample * sample
  return Math.sqrt(sum / input.length)
}
