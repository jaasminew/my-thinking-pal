// Shared mic→PCM16 helper for streaming STT providers that want raw audio
// (Soniox, Speechmatics, iFlytek). getUserMedia → downsample → 16kHz PCM16.
export class PcmMicStream {
  private ctx?: AudioContext
  private processor?: ScriptProcessorNode
  private source?: MediaStreamAudioSourceNode
  private stream?: MediaStream

  async start(
    onPcm: (pcm: ArrayBuffer) => void,
    opts: { stream?: MediaStream; targetRate?: number } = {}
  ): Promise<void> {
    const targetRate = opts.targetRate ?? 16000
    this.stream = opts.stream ?? (await navigator.mediaDevices.getUserMedia({ audio: true }))
    this.ctx = new AudioContext()
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1)
    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      onPcm(floatToPcm16(downsample(input, this.ctx!.sampleRate, targetRate)))
    }
    this.source.connect(this.processor)
    this.processor.connect(this.ctx.destination)
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
    this.stream?.getTracks().forEach((t) => t.stop())
  }
}

export function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (toRate >= fromRate) return input
  const ratio = fromRate / toRate
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) out[i] = input[Math.floor(i * ratio)]
  return out
}

export function floatToPcm16(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}
