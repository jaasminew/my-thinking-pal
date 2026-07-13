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
})
