import type { STTProvider, STTStartOpts, TranscriptEvent } from './types'
import { PcmMicStream } from './pcm'

// STT that routes audio through the Go backend /stt proxy (docs module 07): the
// backend holds the vendor key and the frontend never sees it. Mirrors the fixed
// /stt protocol (7.5): uplink = {type:config} + binary PCM16 + {type:stop};
// downlink = {type:transcript,...} / {type:error,...}.
//
// The transport and mic source are injectable so the protocol logic is testable
// without a real WebSocket or microphone.

export interface SttTransport {
  sendText(s: string): void
  sendBinary(b: ArrayBuffer): void
  onOpen(cb: () => void): void
  onMessage(cb: (text: string) => void): void
  onError(cb: (e: Error) => void): void
  onClose(cb: () => void): void
  close(): void
}

export interface PcmSource {
  start(onPcm: (pcm: ArrayBuffer) => void, opts?: { stream?: MediaStream; targetRate?: number }): Promise<void>
  stop(): void
}

export interface BackendSTTOptions {
  /** WebSocket URL, e.g. wss://host/stt?token=… */
  url: string
  sampleRate?: number
  transport?: SttTransport
  pcm?: PcmSource
}

export class BackendSTT implements STTProvider {
  readonly name = 'Backend'
  private transport?: SttTransport
  private pcm?: PcmSource
  private cb?: (e: TranscriptEvent) => void
  private err?: (e: Error) => void
  private readonly rate: number

  constructor(private readonly opts: BackendSTTOptions) {
    this.rate = opts.sampleRate ?? 16000
  }

  async start(startOpts: STTStartOpts): Promise<void> {
    const transport = this.opts.transport ?? websocketSttTransport(this.opts.url)
    const pcm = this.opts.pcm ?? new PcmMicStream()
    this.transport = transport
    this.pcm = pcm

    transport.onOpen(() => {
      transport.sendText(
        JSON.stringify({ type: 'config', language: startOpts.lang || 'auto', sampleRate: this.rate })
      )
      // Reuse the shared mic→PCM16 pipeline; forward every frame to the backend.
      void pcm.start((buf) => transport.sendBinary(buf), { stream: startOpts.stream, targetRate: this.rate })
    })

    transport.onMessage((text) => {
      let msg: any
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      if (msg?.type === 'transcript') {
        this.cb?.({
          text: msg.text ?? '',
          isFinal: !!msg.final,
          timestamp: performance.now(),
          speaker: msg.speaker || undefined
        })
      } else if (msg?.type === 'error') {
        this.err?.(new Error(`Backend STT: ${msg.error || 'unknown error'}`))
      }
    })

    transport.onError((e) => this.err?.(e))
  }

  stop(): void {
    try {
      this.transport?.sendText(JSON.stringify({ type: 'stop' }))
    } catch {
      /* socket may already be closing */
    }
    this.pcm?.stop()
    this.transport?.close()
  }

  onTranscript(cb: (e: TranscriptEvent) => void): void {
    this.cb = cb
  }
  onError(cb: (err: Error) => void): void {
    this.err = cb
  }
}

// Real browser transport for /stt. Untested here (needs a live socket); the
// protocol logic lives in BackendSTT and is covered via a fake transport.
export function websocketSttTransport(url: string): SttTransport {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const openCbs: (() => void)[] = []
  const msgCbs: ((t: string) => void)[] = []
  const errCbs: ((e: Error) => void)[] = []
  const closeCbs: (() => void)[] = []
  ws.onopen = () => openCbs.forEach((cb) => cb())
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') msgCbs.forEach((cb) => cb(ev.data))
  }
  ws.onerror = () => errCbs.forEach((cb) => cb(new Error('Backend STT socket error')))
  ws.onclose = () => closeCbs.forEach((cb) => cb())
  return {
    sendText: (s) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(s)
    },
    sendBinary: (b) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(b)
    },
    onOpen: (cb) => {
      openCbs.push(cb)
      if (ws.readyState === WebSocket.OPEN) cb()
    },
    onMessage: (cb) => msgCbs.push(cb),
    onError: (cb) => errCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    close: () => ws.close()
  }
}
