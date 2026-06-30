// Acquires the audio MediaStream the STT adapters transcribe. One place that
// knows how to grab mic vs system(tab) vs both — adapters stay source-agnostic.
//
// macOS reality: getDisplayMedia captures a shared *Chrome tab's* audio (check
// "Share tab audio" in the picker), NOT system-wide/other-app audio. For true
// system audio from any app, route through a virtual device (BlackHole) and use
// 'mic' with that device selected. Production does this natively (ScreenCaptureKit).
export type AudioSource = 'mic' | 'system' | 'both'

// Keep AudioContexts alive so the mix graph isn't garbage-collected mid-session.
const liveContexts = new Set<AudioContext>()

export async function getAudioStream(source: AudioSource): Promise<MediaStream> {
  if (source === 'mic') {
    return navigator.mediaDevices.getUserMedia({ audio: true })
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

  // both: mix mic + system(tab) into one stream via Web Audio.
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
  const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  disp.getVideoTracks().forEach((t) => t.stop())
  if (disp.getAudioTracks().length === 0) {
    mic.getTracks().forEach((t) => t.stop())
    disp.getTracks().forEach((t) => t.stop())
    throw new Error('No tab audio captured — pick a tab and check "Share tab audio".')
  }
  const ctx = new AudioContext()
  liveContexts.add(ctx)
  const dest = ctx.createMediaStreamDestination()
  ctx.createMediaStreamSource(mic).connect(dest)
  ctx.createMediaStreamSource(new MediaStream(disp.getAudioTracks())).connect(dest)
  return dest.stream
}
