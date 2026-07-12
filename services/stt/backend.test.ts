import { describe, it, expect, vi } from 'vitest'
import { BackendSTT, type SttTransport, type PcmSource } from './backend'
import type { TranscriptEvent } from './types'

class FakeTransport implements SttTransport {
  private openCb: (() => void) | null = null
  private msgCb: ((t: string) => void) | null = null
  private errCb: ((e: Error) => void) | null = null
  private closeCb: (() => void) | null = null
  texts: string[] = []
  binaries: ArrayBuffer[] = []
  closed = false
  sendText(s: string) { this.texts.push(s) }
  sendBinary(b: ArrayBuffer) { this.binaries.push(b) }
  onOpen(cb: () => void) { this.openCb = cb }
  onMessage(cb: (t: string) => void) { this.msgCb = cb }
  onError(cb: (e: Error) => void) { this.errCb = cb }
  onClose(cb: () => void) { this.closeCb = cb }
  close() { this.closed = true }
  open() { this.openCb?.() }
  deliver(t: string) { this.msgCb?.(t) }
  fail(e: Error) { this.errCb?.(e) }
  remoteClose() { this.closeCb?.() }
}

class FakePcm implements PcmSource {
  onPcm: ((b: ArrayBuffer) => void) | null = null
  stopped = false
  starts = 0
  async start(onPcm: (b: ArrayBuffer) => void) {
    this.starts++
    this.onPcm = onPcm
  }
  stop() { this.stopped = true }
  emit(b: ArrayBuffer) { this.onPcm?.(b) }
}

function setup() {
  const transport = new FakeTransport()
  const pcm = new FakePcm()
  const stt = new BackendSTT({ url: 'ws://x/stt', transport, pcm, sampleRate: 16000 })
  const events: TranscriptEvent[] = []
  const errors: Error[] = []
  stt.onTranscript((e) => events.push(e))
  stt.onError((e) => errors.push(e))
  return { transport, pcm, stt, events, errors }
}

describe('BackendSTT', () => {
  it('sends config and pumps audio on open', async () => {
    const { transport, pcm, stt } = setup()
    await stt.start({ lang: 'auto' })
    transport.open()
    expect(JSON.parse(transport.texts[0])).toEqual({ type: 'config', language: 'auto', sampleRate: 16000 })

    // Give the async pcm.start() a tick to register the callback.
    await Promise.resolve()
    const frame = new Uint8Array([1, 2, 3, 4]).buffer
    pcm.emit(frame)
    expect(transport.binaries[0]).toBe(frame)
  })

  it('maps transcript frames to events', async () => {
    const { transport, stt, events } = setup()
    await stt.start({ lang: 'auto' })
    transport.open()
    transport.deliver('{"type":"transcript","text":"你好","final":false,"language":"zh"}')
    transport.deliver('{"type":"transcript","text":"你好世界","final":true,"language":"zh","speaker":"S1"}')
    expect(events).toEqual([
      { text: '你好', isFinal: false, timestamp: expect.any(Number), language: 'zh', speaker: undefined },
      { text: '你好世界', isFinal: true, timestamp: expect.any(Number), language: 'zh', speaker: 'S1' }
    ])
  })

  it('surfaces backend error frames', async () => {
    const { transport, stt, errors } = setup()
    await stt.start({ lang: 'auto' })
    transport.open()
    transport.deliver('{"type":"error","error":"quota exceeded"}')
    expect(errors[0].message).toContain('quota exceeded')
  })

  it('sends stop and tears down on stop()', async () => {
    const { transport, pcm, stt } = setup()
    await stt.start({ lang: 'auto' })
    transport.open()
    const stopping = stt.stop()
    expect(JSON.parse(transport.texts.at(-1)!)).toEqual({ type: 'stop' })
    expect(pcm.stopped).toBe(true)
    transport.remoteClose()
    await stopping
    expect(transport.closed).toBe(true)
  })

  it('refreshes auth and reconnects without restarting the microphone', async () => {
    vi.useFakeTimers()
    try {
      const first = new FakeTransport()
      const second = new FakeTransport()
      const pcm = new FakePcm()
      const urls: string[] = []
      const transports = [first, second]
      const reconnectUrl = vi.fn(async () => 'ws://x/stt?token=fresh')
      const stt = new BackendSTT({
        url: 'ws://x/stt?token=old',
        pcm,
        reconnectUrl,
        transportFactory: (url) => {
          urls.push(url)
          return transports.shift()!
        }
      })

      await stt.start({ lang: 'auto' })
      first.open()
      await Promise.resolve()
      expect(pcm.starts).toBe(1)

      first.remoteClose()
      await vi.advanceTimersByTimeAsync(500)
      expect(reconnectUrl).toHaveBeenCalledOnce()
      expect(urls).toEqual(['ws://x/stt?token=old', 'ws://x/stt?token=fresh'])

      second.open()
      const frame = new Uint8Array([5, 6]).buffer
      pcm.emit(frame)
      expect(pcm.starts).toBe(1)
      expect(second.binaries).toEqual([frame])

      const stopping = stt.stop()
      second.remoteClose()
      await stopping
    } finally {
      vi.useRealTimers()
    }
  })
})
