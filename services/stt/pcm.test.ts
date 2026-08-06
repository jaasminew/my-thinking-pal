import { describe, expect, it, vi } from 'vitest'
import { PcmMicStream } from './pcm'

describe('PcmMicStream cleanup', () => {
  it('closes its AudioContext only once when stop overlaps', async () => {
    const close = vi.fn(async () => undefined)
    const ctx = { state: 'running', close } as unknown as AudioContext
    const pcm = new PcmMicStream()
    ;(pcm as unknown as { ctx?: AudioContext }).ctx = ctx

    pcm.stop()
    pcm.stop()
    await Promise.resolve()

    expect(close).toHaveBeenCalledTimes(1)
  })

  // A ScriptProcessor block already captured when stop() runs is still
  // delivered afterwards. It used to read this.ctx!.sampleRate, which stop()
  // had just cleared — "Cannot read properties of undefined (reading
  // 'sampleRate')" on every teardown.
  it('survives an audio callback that arrives after stop', async () => {
    const processor = { onaudioprocess: null as any, disconnect: vi.fn(), connect: vi.fn() }
    const ctx = {
      sampleRate: 48000,
      state: 'running',
      destination: {},
      close: vi.fn(async () => undefined),
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      createScriptProcessor: () => processor
    }
    vi.stubGlobal('AudioContext', function () { return ctx } as unknown as typeof AudioContext)

    const onPcm = vi.fn()
    const pcm = new PcmMicStream()
    await pcm.start(onPcm, { stream: { getTracks: () => [] } as unknown as MediaStream })

    const fire = processor.onaudioprocess
    expect(fire).toBeTypeOf('function')
    pcm.stop()
    // The already-queued block, delivered to the handler stop() just detached.
    expect(() =>
      fire({ inputBuffer: { getChannelData: () => new Float32Array(4096) } })
    ).not.toThrow()
    expect(processor.onaudioprocess).toBeNull()

    vi.unstubAllGlobals()
  })
})
