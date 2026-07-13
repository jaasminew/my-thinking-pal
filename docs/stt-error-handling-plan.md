# STT Error Handling Plan

> **For the implementor.** This is a spec, not finished code. Sections:
> the four **recovery-class charts** (what the user sees), a **detection
> reference** (the exact code-level signal + file for each error), an
> **interface change** the retry/reconnect states depend on, **known gaps**,
> and an **implementation order**. Every error has a number (#1–#19); the
> charts and the detection reference share those numbers. User-facing copy in
> the charts is the intended final wording — use it verbatim unless flagged.

Problem: every transcription failure today collapses into one `setErr('⚠ ...')`
string in `Transcript.tsx`, and the record button state is a plain boolean that
never reflects reality. Some failures (device disconnect, silence) never
surface at all. This plan groups every known failure by **recovery action**,
not technical cause, so the UI tells the user what to *do*, not what broke.

Full trace covered: `services/stt/audio-source.ts`, `services/stt/soniox.ts`,
`services/stt/backend.ts`, `services/stt/pcm.ts`, and the wiring in
`apps/web/src/Transcript.tsx` (`useEffect` at line ~231) and
`apps/web/src/App.tsx` (`makeStt`, line ~2483).

## Design principle

Recording state must be an honest state machine, not a boolean:

```
idle -> connecting -> live -> degraded -> reconnecting -> error
```

The record button and a status pill reflect this state. **No error path may
leave the button showing "recording" while nothing is being captured.** Any
error/degraded/reconnecting transition must visibly change the button.

Retry must preserve the transcript already captured — rebuild only the STT
provider + stream, don't wipe `engine` state (`resetCapture()` currently wipes
on every start; retry needs a variant that appends instead).

---

## Class 1 — Fix your device (user action required)

| # | Failure | How it happens | Today | Proposed message + action |
|---|---|---|---|---|
| 1 | Mic permission denied | User blocked mic, or browser policy | `getUserMedia` throws `NotAllowedError` → small ⚠ text, button stays red | "Microphone access is blocked. Allow it in your browser's site settings." + **Try again** |
| 2 | No mic device at start | AirPods not connected yet, no built-in mic selected | `NotFoundError` → ⚠ text | "No microphone found. Connect your mic (e.g. AirPods), then retry." + **Retry** — re-check `enumerateDevices` and auto-enable the button when a device appears |
| 3 | Mic busy / hardware error | Another app holds the device | `NotReadableError` → ⚠ text | "Your microphone is in use by another app. Close it and retry." + **Retry** |
| 4 | Tab-share dialog cancelled | User hits Escape in the picker | `'both'` mode: silent mic-only fallback (console.warn only) | Degraded notice: "Recording mic only — tab audio wasn't shared." + **Share tab audio** to re-open the picker. **Chromium only** — on Safari/Firefox this is unrecoverable, route to #20 |
| 5 | Tab picked, "Share tab audio" unchecked | Easy to miss in Chrome's dialog | Same silent mic-only fallback | Same as #4, with hint: "check 'Share tab audio' in the dialog". **Chromium only** (see #20) |
| 6 | Shared tab closed mid-session | User closes the tab being captured | Tab track ends silently; mic continues | Degraded notice: "Tab audio ended — still recording your mic." + **Re-share** |

## Class 2 — We'll retry for you (automatic, but visible)

| # | Failure | How it happens | Today | Proposed message + action |
|---|---|---|---|---|
| 7 | **Mic device disconnects mid-session** (e.g. AirPods drop) | Bluetooth drops, battery dies | Nothing. Track fires `ended`, no listener exists anywhere in the codebase. Silent death, button stays red | Listen for `track.onended` + `devicechange`. Show "Microphone disconnected — reconnecting…", auto-reacquire `getUserMedia` when a device reappears. **Decision: give up after 15s** and escalate to Class 3 with **Reconnect mic** |
| 8 | OS default input switches | AirPods connect mid-session and macOS switches input | Chrome sometimes follows, sometimes goes silent; no detection | Same `devicechange` listener; if audio level drops to zero after a device change, reacquire the stream |
| 9 | WebSocket drops mid-session | Network blip, laptop sleep/wake | Backend path: silent auto-reconnect ×3 (invisible to user). Soniox local path: **no reconnect at all**, and a 1006 close with empty reason is fully silent (`soniox.ts` only errors when `e.reason` is non-empty) | "Reconnecting…" pill during attempts; add reconnect (or at least an always-fired error) to the Soniox path |
| 10 | Access token expires mid-session | Long sessions | Handled — close → `reconnectUrl()` rotates token | Just the "Reconnecting…" pill; no user action needed |

## Class 3 — Retry manually (one-click retry button)

| # | Failure | How it happens | Today | Proposed message + action |
|---|---|---|---|---|
| 11 | Reconnect attempts exhausted | Network stays down through all backoff attempts (or 15s mic-reconnect timeout from #7) | ⚠ text; button still shows red; mic keeps pumping into a dead socket | Force state out of `live`: "Connection lost. Your transcript so far is saved." + **Resume recording** (rebuild socket, keep engine transcript) |
| 12 | WS never connects at start | Server down, offline, firewall | ⚠ text after browser timeout; no feedback during the wait | Show "Connecting…" state first; on failure: "Can't reach the transcription server." + **Retry** |
| 13 | Backend in-band `{type:error}` | Vendor error relayed by the Go proxy, bad config frame | ⚠ text mid-session; stream may continue or stall | "Transcription error: {detail}." + **Restart transcription** |
| 14 | Soniox in-band `error_code` mid-stream | Vendor-side transient failure | ⚠ text; session left half-alive | Same as #13 |
| 15 | Transcript stall (no events despite audio) | Provider degradation — no error event exists for this | Invisible | Watchdog: after ~20s of audio with zero transcript events → "Transcription stalled." + **Restart** |

## Class 4 — Can't fix here (explain, no futile retry)

| # | Failure | How it happens | Today | Proposed message + action |
|---|---|---|---|---|
| 16 | Signed out / auth refresh fails | Session expired before or during recording | `makeStt` throws "Sign in to use backend speech transcription" as ⚠ text | Blocking notice: "Sign in to enable transcription." + **Sign in** (link to auth panel), record button disabled |
| 17 | No Soniox key (local dev path) | Running dev without `SONIOX_API_KEY` | Long ⚠ text | Dev-only notice, styled as a setup instruction, no retry button |
| 18 | Vendor auth/billing/quota rejection | Bad key, quota exhausted | In-band `error_code` → ⚠ text | "Transcription service unavailable (account issue)." No retry; log details for debugging, not shown to user |
| 19 | Silence — mic muted at OS/hardware level | Muted AirPods, input gain zero | Invisible — nothing fails at the API level | No error event exists; requires an audio-level watchdog: "Not hearing anything — is your mic muted?" |
| 20 | Tab/screen audio on Safari | WebKit's `getDisplayMedia` ignores `audio: true` and returns a **video-only** stream — even when sharing the entire screen. Retrying is futile; every attempt yields zero audio tracks. This is a permanent browser limitation, not a user error | **Skip the share modal entirely** on Safari (don't prompt for something that can't work). Keep recording the mic. Degraded notice: "Safari can't capture tab or screen audio. Use Chrome to record shared audio." **Gate strictly to Safari** — never show in Chrome/Edge or the Chromium desktop app (Electron). **Open question: Firefox** — its display-audio support is partial and the current `browserSupportsDisplayAudio()` UA check does NOT cover it; verify Firefox behavior and extend the gate if needed |

---

## Detection reference (code-level signal per error)

The exact thing to detect and where to wire it. File paths are relative to repo
root. "New" = no hook exists today; the implementor adds it.

| # | Detection signal | Where to wire it |
|---|---|---|
| 1 | `getUserMedia` rejects with `DOMException.name === 'NotAllowedError'` | `services/stt/audio-source.ts` `getAudioStream()`; also `services/stt/pcm.ts` `start()` (fallback path). Catch → map by `.name` |
| 2 | Same call, `.name === 'NotFoundError'` | same as #1. For recovery, poll `navigator.mediaDevices.enumerateDevices()` or listen to `devicechange` to re-enable the button |
| 3 | Same call, `.name === 'NotReadableError'` (or `OverconstrainedError`) | same as #1 |
| 4 | `'both'` mode: `getDisplayMedia` **rejects** | `audio-source.ts` line ~35 `catch (e)` — currently returns `mic` silently. Emit a degraded event instead of swallowing |
| 5 | `'both'`/`'system'` mode: `disp.getAudioTracks().length === 0` | `audio-source.ts` lines ~40 / ~21. Currently `console.warn` + mic-only. Emit degraded |
| 6 | Shared-tab audio track fires `'ended'` while mic still live | **New.** Add `track.onended` to the display audio track kept in `audio-source.ts` (the mix path, line ~49) |
| 7 | Mic `MediaStreamTrack` fires `'ended'`, and/or `navigator.mediaDevices.ondevicechange` fires and the mic track goes `readyState === 'ended'` | **New.** No listener exists anywhere. Wire on the mic track from `getUserMedia`; needs to reach the STT supervisor to trigger reacquire |
| 8 | `navigator.mediaDevices.ondevicechange` fires + audio level drops to ~0 | **New.** Same listener as #7; combine with the #19 level meter |
| 9 | Backend: `transport.onClose` with `stopping === false` (already triggers reconnect). Soniox: `ws.onclose` with `e.code === 1006` (empty `reason`) | `services/stt/backend.ts` line ~68 (reconnect exists, just invisible). `services/stt/soniox.ts` line ~113 — **bug:** only errors when `e.reason` is truthy, so 1006 is dropped |
| 10 | Backend close → `reconnectUrl()` succeeds (already handled) | `backend.ts` `reconnect()` line ~120. Only needs the "Reconnecting…" pill surfaced |
| 11 | `backend.ts` `reconnect()` hits `maxReconnectAttempts` → calls `this.err?.()` | `backend.ts` line ~127. Today this only fires `onError`; needs to drive state → `error` and offer Resume |
| 12 | Socket never opens: `websocketSttTransport` `ws.onerror` before any `onOpen` | `backend.ts` line ~185 / the `connect()` open path. Distinguish "never connected" from "dropped mid-session" |
| 13 | Backend downlink `{ type: 'error' }` | `backend.ts` `onMessage`, line ~110 |
| 14 | Soniox in-band `data.error_code` on a message frame | `soniox.ts` `ws.onmessage`, line ~77 |
| 15 | No `onTranscript` event (interim or final) for ~20s while PCM is still being sent | **New.** Timer in `Transcript.tsx` around the `stt.onTranscript` handler (line ~267), reset on every event |
| 16 | `makeStt` factory throws (`refreshAuth()` false / `sttUrl()` null) | `apps/web/src/App.tsx` `makeStt`, line ~2485. Already surfaces as text; make it a blocking state with a Sign-in action |
| 17 | `devSonioxKey()` returns no key | `soniox.ts` `start()`, line ~26. Dev-only |
| 18 | Soniox `error_code` that is auth/quota/billing; backend `{type:error}` with an account detail | `soniox.ts` line ~77 / `backend.ts` line ~110. Same hooks as #14/#13, different copy + no retry |
| 19 | Compute RMS/peak of the Float32 frame in the audio processor; ~0 for ~10s while `live` | **New.** `services/stt/pcm.ts` `onaudioprocess` (line ~18) and the equivalent in `soniox.ts` (line ~59). Emit a level so the UI can meter it AND fire the silence warning |
| 20 | `browserSupportsDisplayAudio()` (UA check, Safari-only) in `audio-source.ts` line ~86, called before the display path. Belt-and-suspenders: after `getDisplayMedia`, `getAudioTracks().length === 0` also routes to a `tab-audio-unsupported` degraded event | **Done** (line ~54, ~71, ~86). Short-circuits the `'system'`/`'both'` path on Safari and skips the modal. Note: check covers Safari, not Firefox — see #20 open question |

## Interface change this depends on (decide first)

`STTProvider` (`services/stt/types.ts`) currently exposes only `onTranscript`
and `onError`. That is enough for a terminal error, but **not** for the
Class 2 "reconnecting" / "degraded" states, the #15 stall watchdog, or the #19
level meter — those are neither a transcript nor a fatal error.

The implementor must pick one, before building the charts:

- **A. Extend the provider contract** — add `onStatus(cb: (s: SttState) => void)`
  to `STTProvider`, and have `BackendSTT` / `SonioxSTT` emit
  `connecting | live | reconnecting | degraded | error`. Cleanest; keeps audio
  concerns in the adapters. Requires touching both adapters + the fake
  transport in tests.
- **B. Lift the state machine into `Transcript.tsx`** — derive state from the
  existing `onError`/`onTranscript` callbacks plus new DOM listeners
  (`track.onended`, `devicechange`) and timers. Less adapter churn but scatters
  the logic and can't see the WS reconnect attempts happening inside
  `BackendSTT`.

Recommendation: **A** for anything the adapter already knows (reconnect, in-band
errors), **B** for device/DOM events (#6–#8) and watchdogs (#15, #19) that live
above the socket. This is a design call — flag it for Jasmine before coding.

## Already shipped (do not rebuild)

A **stopped/done status line** and the "Listening… highlights appear every ~2
minutes" copy already exist in `Transcript.tsx` (status caption + `stopped`
derivation). In particular, the empty-stop case already shows *"Stopped — no
speech was captured. Check your mic and try again."* That is a **status**
message, distinct from the #19 **silence watchdog** (which fires mid-recording).
Don't duplicate; #19 should coordinate with that existing copy, not replace it.

**#20 (Safari tab/screen audio) is already implemented** — `audio-source.ts`
skips the Safari share modal, keeps the mic recording, and shows the "use
Chrome" notice. Left in this doc for completeness; verify the copy matches the
final wording above and that the gate never triggers in the Electron desktop
app (Chromium), then treat it as done.

## Known gaps found while tracing (fix regardless of UI work)

- **#7 has zero handling today** — no `track.onended` or `devicechange`
  listener exists anywhere in `services/stt/*` or `Transcript.tsx`. This is
  the root cause of the AirPods problem: the disconnect is real and
  detectable, it's just never listened for.
- **Soniox local path swallows silent closes** — `soniox.ts` only calls
  `this.err?.()` on close if `e.reason` is non-empty. Code `1006` (abnormal
  closure, the most common network-failure code) has an empty reason and is
  dropped silently.
- **`'both'` audio mode fails silently on tab-share cancel** — `audio-source.ts`
  falls back to mic-only with only a `console.warn`, never reaching the user.

## Implementation order

1. **State machine** (`idle/connecting/live/degraded/reconnecting/error`) —
   everything else depends on the button being honest first.
2. **#7 mic-disconnect handling** — `track.onended` + `devicechange` listener,
   15s reconnect window, then escalate to Class 3 retry. Fixes the reported
   pain point directly.
3. **Class 3 retry button** — rebuild STT provider + stream without wiping
   `engine` transcript state.
4. **Class 1 messaging** — map `getUserMedia` error names
   (`NotAllowedError`/`NotFoundError`/`NotReadableError`) to the specific
   copy above.
5. **Watchdogs (#15, #19)** — transcript-stall and audio-level silence
   detection. Lowest priority; no existing error path to hook into, needs
   new timers.
