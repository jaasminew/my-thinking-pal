import type { STTProvider, STTStartOpts, TranscriptEvent } from './types'

// Real-time multilingual STT with code-switching (中英混说). Soniox auto-detects
// language per token and handles Chinese+English in one utterance — which
// WebSpeech (single language) and Deepgram (weak Mandarin) cannot.
//
// Needs SONIOX_API_KEY in .env (browser fetches it + model from /api/soniox-key).
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
  private readonly TARGET_RATE = 16000

  async start(opts: STTStartOpts): Promise<void> {
    const { key, model } = await (await fetch('/api/soniox-key')).json()
    if (!key) throw new Error('No SONIOX_API_KEY in .env — add one or use WebSpeech.')

    this.stream = opts.stream ?? (await navigator.mediaDevices.getUserMedia({ audio: true }))
    this.ctx = new AudioContext()
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1)

    const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket')
    this.ws = ws

    ws.onopen = () => {
      // First frame is the JSON config; language_hints + auto-detection enable
      // mixed Chinese/English in a single stream.
      ws.send(
        JSON.stringify({
          api_key: key,
          model: model || 'stt-rt-v5',
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
        if (ws.readyState !== WebSocket.OPEN) return
        const input = e.inputBuffer.getChannelData(0)
        const pcm = floatToPcm16(downsample(input, this.ctx!.sampleRate, this.TARGET_RATE))
        ws.send(pcm)
      }
      this.source!.connect(this.processor!)
      this.processor!.connect(this.ctx!.destination)
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
        this.err?.(new Error(`Soniox ${data.error_code}: ${data.error_message || data.error_type}`))
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
      const flushRun = () => {
        if (run.trim()) this.cb?.({ text: run, isFinal: true, timestamp: ts, speaker: runSpeaker })
        run = ''
      }
      for (const t of finals) {
        const spk = t.speaker != null && t.speaker !== '' ? `S${t.speaker}` : undefined
        if (run && spk !== runSpeaker) flushRun()
        runSpeaker = spk
        run += t.text
      }
      flushRun()
      const interimText = tokens.filter((t: any) => !t.is_final).map((t: any) => t.text).join('')
      if (interimText.trim()) this.cb?.({ text: interimText, isFinal: false, timestamp: ts })
    }

    ws.onerror = () => this.err?.(new Error('Soniox WS error — check key / proxy.'))
    ws.onclose = (e) => {
      console.log('[Soniox] WS closed', e.code, e.reason)
      // Soniox sends a descriptive reason on config/auth rejection.
      if (e.code !== 1000 && e.code !== 1005 && e.reason) {
        this.err?.(new Error(`Soniox closed (${e.code}): ${e.reason}`))
      }
    }
  }

  stop(): void {
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
