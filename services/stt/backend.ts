import type { STTProvider, STTStartOpts, SttStatusEvent, TranscriptEvent } from './types'
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
  start(onPcm: (pcm: ArrayBuffer) => void, opts?: { stream?: MediaStream; targetRate?: number; onLevel?: (level: number) => void }): Promise<void>
  stop(): void
}

export interface BackendSTTOptions {
  /** WebSocket URL, e.g. wss://host/stt?token=… */
  url: string
  sampleRate?: number
  transport?: SttTransport
  transportFactory?: (url: string) => SttTransport
  /** Return a URL carrying a freshly rotated token after an unexpected close. */
  reconnectUrl?: () => Promise<string>
  maxReconnectAttempts?: number
  pcm?: PcmSource
}

export class BackendSTT implements STTProvider {
  readonly name = 'Backend'
  private transport?: SttTransport
  private pcm?: PcmSource
  private cb?: (e: TranscriptEvent) => void
  private err?: (e: Error) => void
  private statusCb?: (status: SttStatusEvent) => void
  private levelCb?: (level: number) => void
  private readonly rate: number
  private closed?: Promise<void>
  private stopping = false
  private pcmStarted = false
  private startOpts?: STTStartOpts
  private reconnectAttempts = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private lastSocketError?: Error

  constructor(private readonly opts: BackendSTTOptions) {
    this.rate = opts.sampleRate ?? 16000
  }

  async start(startOpts: STTStartOpts): Promise<void> {
    this.startOpts = startOpts
    this.pcm = this.opts.pcm ?? new PcmMicStream()
    this.statusCb?.({ state: 'connecting' })
    this.connect(this.opts.url, this.opts.transport)
  }

  private connect(url: string, injected?: SttTransport): void {
    const transport = injected ?? this.opts.transportFactory?.(url) ?? websocketSttTransport(url)
    let opened = false
    const connectTimer = setTimeout(() => {
      if (opened || this.stopping || this.transport !== transport) return
      this.fail(new Error('Backend STT connection timed out'))
      transport.close()
    }, 10_000)
    this.transport = transport
    this.closed = new Promise((resolve) => {
      transport.onClose(() => {
        clearTimeout(connectTimer)
        resolve()
        if (this.transport !== transport || this.stopping) return
        this.statusCb?.({ state: 'reconnecting' })
        void this.reconnect()
      })
    })
    transport.onOpen(() => {
      if (this.transport !== transport || this.stopping) return
      opened = true
      clearTimeout(connectTimer)
      this.reconnectAttempts = 0
      this.lastSocketError = undefined
      this.statusCb?.({ state: 'live' })
      transport.sendText(
        JSON.stringify({ type: 'config', language: this.startOpts?.lang || 'auto', sampleRate: this.rate })
      )
      // Start the microphone once. Its callback follows this.transport, so audio
      // automatically flows into a replacement socket after reconnection.
      if (!this.pcmStarted) {
        this.pcmStarted = true
        void this.pcm
          ?.start((buf) => this.transport?.sendBinary(buf), {
            stream: this.startOpts?.stream,
            targetRate: this.rate,
            onLevel: (level) => this.levelCb?.(level)
          })
          .catch((e) => this.fail(e instanceof Error ? e : new Error(String(e))))
      }
    })

    transport.onMessage((text) => {
      if (this.transport !== transport) return
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
          language: msg.language || undefined,
          speaker: msg.speaker || undefined
        })
      } else if (msg?.type === 'error') {
        this.fail(new Error(`Backend STT: ${msg.error || 'unknown error'}`))
      }
    })

    transport.onError((e) => {
      if (!this.stopping && this.transport === transport) this.lastSocketError = e
    })
  }

  private async reconnect(): Promise<void> {
    if (this.stopping) return
    if (!this.opts.reconnectUrl) {
      this.fail(this.lastSocketError ?? new Error('Backend STT connection closed unexpectedly'))
      return
    }
    const maxAttempts = this.opts.maxReconnectAttempts ?? 3
    if (this.reconnectAttempts >= maxAttempts) {
      this.fail(this.lastSocketError ?? new Error('Backend STT reconnect failed'))
      return
    }
    const attempt = ++this.reconnectAttempts
    await new Promise<void>((resolve) => {
      this.reconnectTimer = setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 4000))
    })
    if (this.stopping) return
    try {
      const url = await this.opts.reconnectUrl()
      if (!url) throw new Error('Backend speech session is unavailable')
      this.connect(url)
    } catch (e) {
      this.lastSocketError = e instanceof Error ? e : new Error(String(e))
      void this.reconnect()
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    try {
      this.transport?.sendText(JSON.stringify({ type: 'stop' }))
    } catch {
      /* socket may already be closing */
    }
    this.pcm?.stop()
    if (this.closed) {
      await Promise.race([
        this.closed,
        new Promise<void>((resolve) => setTimeout(resolve, 3500))
      ])
    }
    this.transport?.close()
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

  private fail(error: Error): void {
    this.statusCb?.({ state: 'error', detail: error.message })
    this.err?.(error)
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
