import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserSupportsDisplayAudio, getAudioStream } from './audio-source'

class FakeTrack extends EventTarget {
  stop() {
    this.dispatchEvent(new Event('ended'))
  }
}

class FakeStream {
  constructor(private readonly audio: FakeTrack[] = [], private readonly video: FakeTrack[] = []) {}
  getAudioTracks() { return this.audio }
  getVideoTracks() { return this.video }
  getTracks() { return [...this.audio, ...this.video] }
}

afterEach(() => vi.unstubAllGlobals())

describe('getAudioStream recovery events', () => {
  it('recognizes Safari as lacking display-audio capture', () => {
    expect(browserSupportsDisplayAudio('Mozilla/5.0 Version/18.5 Safari/605.1.15')).toBe(false)
    expect(browserSupportsDisplayAudio('Mozilla/5.0 Chrome/138.0.0.0 Safari/537.36')).toBe(true)
  })

  it('reports a cancelled tab picker while preserving microphone capture', async () => {
    const mic = new FakeStream([new FakeTrack()])
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => mic),
        getDisplayMedia: vi.fn(async () => { throw new DOMException('cancelled', 'AbortError') })
      }
    })
    const events: string[] = []

    const result = await getAudioStream('both', { onEvent: (event) => events.push(event.type === 'degraded' ? event.reason : event.type) })

    expect(result).toBe(mic)
    expect(events).toEqual(['tab-cancelled'])
  })

  it('reports when the acquired microphone track ends', async () => {
    const track = new FakeTrack()
    const mic = new FakeStream([track])
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => mic) } })
    const events: string[] = []
    await getAudioStream('mic', { onEvent: (event) => events.push(event.type) })

    track.stop()

    expect(events).toEqual(['mic-ended'])
  })

  it('uses a display stream already acquired by the share-button click', async () => {
    const mic = new FakeStream([new FakeTrack()])
    const display = new FakeStream()
    const getDisplayMedia = vi.fn()
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => mic), getDisplayMedia }
    })
    const events: string[] = []

    const result = await getAudioStream('both', {
      displayStream: display as unknown as MediaStream,
      onEvent: (event) => events.push(event.type === 'degraded' ? event.reason : event.type)
    })

    expect(result).toBe(mic)
    expect(getDisplayMedia).not.toHaveBeenCalled()
    expect(events).toEqual(['tab-audio-missing'])
  })

  it('skips Safari screen sharing and continues with the microphone', async () => {
    const mic = new FakeStream([new FakeTrack()])
    const getDisplayMedia = vi.fn()
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 Version/18.5 Safari/605.1.15',
      mediaDevices: { getUserMedia: vi.fn(async () => mic), getDisplayMedia }
    })
    const events: string[] = []

    const result = await getAudioStream('both', {
      onEvent: (event) => events.push(event.type === 'degraded' ? event.reason : event.type)
    })

    expect(result).toBe(mic)
    expect(getDisplayMedia).not.toHaveBeenCalled()
    expect(events).toEqual(['tab-audio-unsupported'])
  })
})
