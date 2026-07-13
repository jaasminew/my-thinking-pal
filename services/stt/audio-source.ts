// Acquires the audio MediaStream the STT adapters transcribe. One place that
// knows how to grab mic vs system(tab) vs both — adapters stay source-agnostic.
//
// macOS reality: getDisplayMedia captures a shared *Chrome tab's* audio (check
// "Share tab audio" in the picker), NOT system-wide/other-app audio. For true
// system audio from any app, route through a virtual device (BlackHole) and use
// 'mic' with that device selected. Production does this natively (ScreenCaptureKit).
export type AudioSource = 'mic' | 'system' | 'both'

export type AudioSourceEvent =
  | { type: 'degraded'; reason: 'tab-cancelled' | 'tab-audio-missing' | 'tab-audio-unsupported' }
  | { type: 'mic-ended' }
  | { type: 'tab-ended' }

export interface AudioSourceOptions {
  onEvent?: (event: AudioSourceEvent) => void
  /** A display stream acquired synchronously from a user click. */
  displayStream?: MediaStream
}

// Keep AudioContexts alive so the mix graph isn't garbage-collected mid-session.
const liveContexts = new Set<AudioContext>()
const backingCapture = new WeakMap<MediaStream, { tracks: MediaStreamTrack[]; context?: AudioContext }>()

export async function getAudioStream(source: AudioSource, opts: AudioSourceOptions = {}): Promise<MediaStream> {
  if (source === 'mic') {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
    watchTracks(mic.getAudioTracks(), () => opts.onEvent?.({ type: 'mic-ended' }))
    return mic
  }

  if (source === 'system') {
    const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    disp.getVideoTracks().forEach((t) => t.stop()) // audio only
    if (disp.getAudioTracks().length === 0) {
      disp.getTracks().forEach((t) => t.stop())
      throw new Error('No tab audio captured — in the share dialog, pick a tab and check "Share tab audio".')
    }
    return new MediaStream(disp.getAudioTracks())
  }

  // both: mix mic + system(tab) into one stream via Web Audio. Tab audio is a
  // best-effort enhancement: some browsers/platforms throw low-level capture
  // errors, and users often only need the mic. Keep recording instead of failing.
  let mic: MediaStream
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (error) {
    opts.displayStream?.getTracks().forEach((track) => track.stop())
    throw error
  }
  watchTracks(mic.getAudioTracks(), () => opts.onEvent?.({ type: 'mic-ended' }))
  if (!opts.displayStream && !browserSupportsDisplayAudio()) {
    opts.onEvent?.({ type: 'degraded', reason: 'tab-audio-unsupported' })
    return mic
  }
  let disp: MediaStream
  try {
    disp = opts.displayStream ?? (await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }))
  } catch (e) {
    console.warn('[audio-source] falling back to microphone-only capture', e)
    opts.onEvent?.({ type: 'degraded', reason: 'tab-cancelled' })
    return mic
  }
  disp.getVideoTracks().forEach((t) => t.stop())
  if (disp.getAudioTracks().length === 0) {
    disp.getTracks().forEach((t) => t.stop())
    console.warn('[audio-source] no tab audio captured; using microphone-only capture')
    opts.onEvent?.({
      type: 'degraded',
      reason: browserSupportsDisplayAudio() ? 'tab-audio-missing' : 'tab-audio-unsupported'
    })
    return mic
  }
  watchTracks(disp.getAudioTracks(), () => opts.onEvent?.({ type: 'tab-ended' }))
  const ctx = new AudioContext()
  liveContexts.add(ctx)
  const dest = ctx.createMediaStreamDestination()
  ctx.createMediaStreamSource(mic).connect(dest)
  ctx.createMediaStreamSource(new MediaStream(disp.getAudioTracks())).connect(dest)
  backingCapture.set(dest.stream, { tracks: [...mic.getTracks(), ...disp.getTracks()], context: ctx })
  return dest.stream
}

/** Safari exposes screen video via getDisplayMedia but not its audio track. */
export function browserSupportsDisplayAudio(userAgent = navigator.userAgent): boolean {
  return !(/Safari\//.test(userAgent) && !/(Chrome|Chromium|CriOS|Edg|OPR)\//.test(userAgent))
}

/** Stops both a returned mix and the original mic/display tracks behind it. */
export function stopAudioStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop())
  const backing = backingCapture.get(stream)
  backing?.tracks.forEach((track) => track.stop())
  if (backing?.context) {
    liveContexts.delete(backing.context)
    void backing.context.close()
  }
  backingCapture.delete(stream)
}

function watchTracks(tracks: MediaStreamTrack[], onEnded: () => void): void {
  tracks.forEach((track) => track.addEventListener('ended', onEnded, { once: true }))
}
