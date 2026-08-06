// Shared mic→PCM16 helper for streaming STT providers that want raw audio
// (Soniox, Speechmatics, iFlytek). getUserMedia → downsample → 16kHz PCM16.
export class PcmMicStream {
  private ctx?: AudioContext
  private processor?: ScriptProcessorNode
  private source?: MediaStreamAudioSourceNode
  private stream?: MediaStream

  async start(
    onPcm: (pcm: ArrayBuffer) => void,
    opts: { stream?: MediaStream; targetRate?: number; onLevel?: (level: number) => void } = {}
  ): Promise<void> {
    const targetRate = opts.targetRate ?? 16000
    this.stream = opts.stream ?? (await navigator.mediaDevices.getUserMedia({ audio: true }))
    const ctx = new AudioContext()
    this.ctx = ctx
    this.source = ctx.createMediaStreamSource(this.stream)
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    this.processor = processor
    // Read the device rate once, here. A ScriptProcessor callback already
    // queued when stop() runs still fires afterwards, and stop() has by then
    // cleared this.ctx — reaching for `this.ctx!.sampleRate` inside the handler
    // threw "Cannot read properties of undefined" on every teardown.
    const sourceRate = ctx.sampleRate
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      opts.onLevel?.(rms(input))
      onPcm(floatToPcm16(downsample(input, sourceRate, targetRate)))
    }
    this.source.connect(processor)
    processor.connect(ctx.destination)
  }

  stop(): void {
    const processor = this.processor
    const source = this.source
    const ctx = this.ctx
    const stream = this.stream
    this.processor = undefined
    this.source = undefined
    this.ctx = undefined
    this.stream = undefined
    // Detach before disconnecting: a disconnected node can still deliver the
    // block it had already captured, and that callback must not outlive stop().
    if (processor) processor.onaudioprocess = null
    try {
      processor?.disconnect()
      source?.disconnect()
    } catch {
      /* noop */
    }
    if (ctx && ctx.state !== 'closed') {
      void ctx.close().catch(() => {
        /* another teardown may have closed it first */
      })
    }
    stream?.getTracks().forEach((t) => t.stop())
  }
}

function rms(input: Float32Array): number {
  if (!input.length) return 0
  let sum = 0
  for (const sample of input) sum += sample * sample
  return Math.sqrt(sum / input.length)
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
