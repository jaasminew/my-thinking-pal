import type { STTProvider, STTStartOpts, TranscriptEvent } from './types'
import { PcmMicStream } from './pcm'

// iFlytek 讯飞 RTASR — best Mandarin + 中英混说, proxy-free in China.
// The server signs the wss URL (/api/iflytek-url) using APPID + API key (HMAC).
// RTASR wants 16kHz/16bit/mono PCM in ~1280-byte frames, so we buffer to that.
// UNVERIFIED until IFLYTEK_APPID / IFLYTEK_API_KEY are set — validate framing
// and the result JSON shape against current 讯飞 RTASR docs.
export class IflytekSTT implements STTProvider {
  readonly name = '讯飞'
  private ws?: WebSocket
  private mic = new PcmMicStream()
  private buf: number[] = []
  private cb?: (e: TranscriptEvent) => void
  private err?: (e: Error) => void
  private readonly FRAME = 1280 // bytes

  async start(opts: STTStartOpts): Promise<void> {
    const { url } = await (await fetch('/api/iflytek-url')).json()
    if (!url) throw new Error('No IFLYTEK_APPID / IFLYTEK_API_KEY in .env.')
    const audioStream = opts.stream

    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.mic.start((pcm) => this.pushAudio(new Uint8Array(pcm)), { stream: audioStream })
    }

    ws.onmessage = (m) => {
      let d: any
      try {
        d = JSON.parse(m.data)
      } catch {
        return
      }
      if (d.action === 'error') return this.err?.(new Error('讯飞: ' + (d.desc || d.code)))
      if (d.action !== 'result') return
      try {
        const r = JSON.parse(d.data)
        const st = r.cn.st
        const text = (st.rt || [])
          .flatMap((rt: any) => rt.ws || [])
          .flatMap((w: any) => w.cw || [])
          .map((cw: any) => cw.w)
          .join('')
        if (!text) return
        // type '0' = final segment, '1' = interim
        this.cb?.({ text, isFinal: st.type === '0', timestamp: performance.now() })
      } catch {
        /* ignore malformed frame */
      }
    }

    ws.onerror = () => this.err?.(new Error('讯飞 WS error.'))
    ws.onclose = (e) => {
      if (e.code !== 1000 && e.code !== 1005) this.err?.(new Error(`讯飞 closed (${e.code}) ${e.reason || ''}`))
    }
  }

  // Accumulate PCM and ship in fixed 1280-byte frames RTASR expects.
  private pushAudio(bytes: Uint8Array) {
    for (let i = 0; i < bytes.length; i++) this.buf.push(bytes[i])
    while (this.buf.length >= this.FRAME) {
      const frame = new Uint8Array(this.buf.splice(0, this.FRAME))
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame)
    }
  }

  stop(): void {
    this.mic.stop()
    try {
      this.ws?.send(JSON.stringify({ end: true }))
      this.ws?.close()
    } catch {
      /* noop */
    }
    this.buf = []
  }

  onTranscript(cb: (e: TranscriptEvent) => void): void {
    this.cb = cb
  }
  onError(cb: (err: Error) => void): void {
    this.err = cb
  }
}
