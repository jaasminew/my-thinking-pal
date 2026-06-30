import './styles.css'
import { SonioxSTT } from '../../services/stt/soniox'
import { SpeechmaticsSTT } from '../../services/stt/speechmatics'
import { IflytekSTT } from '../../services/stt/iflytek'
import { getAudioStream, type AudioSource } from '../../services/stt/audio-source'
import type { STTProvider } from '../../services/stt/types'

// Two-stage picks (specialized STT → separate text LLM): multilingual + low
// latency. (WebSpeech/Deepgram adapters remain in services/stt but are unwired.)
const STT_FACTORY: Record<string, () => STTProvider> = {
  soniox: () => new SonioxSTT(),
  speechmatics: () => new SpeechmaticsSTT(),
  iflytek: () => new IflytekSTT()
}
import { CleanupEngine } from './cleanup'
import { LatencyTracker } from './latency'
import { renderCleanedTranscript } from './render'

const DEFAULT_PROMPT =
  `You turn rough live STT from a brainstorming session into concise structured thinking notes. ` +
  `Do NOT preserve the speaker's wording. Remove fillers, hedges, repeated starts, and conversational phrasing. ` +
  `Rewrite freely into polished, written language while preserving only the user's actual meaning. ` +
  `Match the user's language. If the user mainly speaks Chinese, write Chinese. If they mainly speak English, write English. ` +
  `If they code-switch, preserve that mix only when the mixed wording carries meaning; otherwise use the dominant language. ` +
  `Be brief and structured: use compact bullets or short labeled lines by default. ` +
  `Do not create keyword-only fragments. Do not repeat the same idea in Chinese and English. ` +
  `If two fragments mean the same thing, merge them into one complete bullet. ` +
  `Do not add new claims, examples, or conclusions beyond the raw input. ` +
  `Mark only the key ideas with ==double equals== inside your output.`

// --- DOM ---
const $ = (id: string) => document.getElementById(id)!
const transcriptEl = $('transcript')
const latencyEl = $('latency')
const statusEl = $('status')
const toggleBtn = $('toggle') as HTMLButtonElement
const promptEl = $('prompt') as HTMLTextAreaElement
const fadeValEl = $('fadeVal')

promptEl.value = DEFAULT_PROMPT

// --- state ---
const latency = new LatencyTracker()
let stt: STTProvider | null = null
let running = false

const engine = new CleanupEngine({
  provider: 'groq',
  model: 'openai/gpt-oss-20b',
  systemPrompt: DEFAULT_PROMPT,
  pauseMs: 1500,
  minWords: 12,
  minCjkChars: 12
})

engine.onRender = (latestIndex, busy) =>
  renderCleanedTranscript(transcriptEl, engine.segments, latestIndex, busy)
engine.onLatency = (s) => {
  latency.record(s)
  latency.render(latencyEl)
}
engine.onError = (msg) => setStatus(`⚠ ${msg}`, true)

// --- controls wiring ---
function selectGroup(groupId: string, onPick: (value: string) => void) {
  const group = $(groupId)
  group.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      group.querySelectorAll('button').forEach((x) => x.classList.remove('active'))
      b.classList.add('active')
      onPick((b as HTMLButtonElement).dataset.value!)
    })
  )
}

selectGroup('sttGroup', (v) => {
  sttKind = v
  if (running) setStatus('STT change applies after Stop / Start', false)
})
selectGroup('modelGroup', (v) => (engine.config.provider = v))

const groqModelSel = $('groqModel') as HTMLSelectElement
groqModelSel.addEventListener('change', () => {
  engine.config.model = groqModelSel.value
  if (running) setStatus(`Cleanup model → ${groqModelSel.value}`, false)
})

let sttKind = 'soniox'
let audioSource: AudioSource = 'mic'

selectGroup('sourceGroup', (v) => {
  audioSource = v as AudioSource
  if (running) setStatus('Audio source change applies after Stop / Start', false)
})

promptEl.addEventListener('input', () => (engine.config.systemPrompt = promptEl.value))

const pauseSlider = $('pauseMs') as HTMLInputElement
const pauseValEl = $('pauseVal')
pauseSlider.addEventListener('input', () => {
  engine.config.pauseMs = +pauseSlider.value
  pauseValEl.textContent = `${pauseSlider.value}ms`
})

const minWordsSlider = $('minWords') as HTMLInputElement
const minWordsValEl = $('minWordsVal')
minWordsSlider.addEventListener('input', () => {
  engine.config.minWords = +minWordsSlider.value
  minWordsValEl.textContent = minWordsSlider.value
})

const minCjkSlider = $('minCjkChars') as HTMLInputElement
const minCjkValEl = $('minCjkCharsVal')
minCjkSlider.addEventListener('input', () => {
  engine.config.minCjkChars = +minCjkSlider.value
  minCjkValEl.textContent = minCjkSlider.value
})

const fadeSlider = $('fade') as HTMLInputElement
fadeSlider.addEventListener('input', () => {
  document.documentElement.style.setProperty('--fade-ms', `${fadeSlider.value}ms`)
  fadeValEl.textContent = `${fadeSlider.value}ms`
})

const langSel = $('lang') as HTMLSelectElement

toggleBtn.addEventListener('click', () => (running ? stop() : start()))

// --- lifecycle ---
async function start() {
  engine.reset()
  latency.reset()
  latency.render(latencyEl)
  renderCleanedTranscript(transcriptEl, engine.segments, null, false)

  // Acquire the chosen audio source first, inside the click gesture (system/both
  // need getDisplayMedia, which requires user activation).
  let stream: MediaStream
  try {
    stream = await getAudioStream(audioSource)
  } catch (e: any) {
    setStatus(`⚠ ${e.message}`, true)
    return
  }

  stt = (STT_FACTORY[sttKind] || STT_FACTORY.soniox)()
  stt.onError((e) => setStatus(`⚠ ${e.message}`, true))
  stt.onTranscript((ev) => {
    if (ev.isFinal) engine.pushFinal(ev.text, ev.timestamp)
    else engine.pushInterim(ev.text)
  })

  try {
    await stt.start({ lang: langSel.value, stream })
    running = true
    toggleBtn.textContent = 'Stop'
    toggleBtn.classList.add('recording')
    setStatus(`Listening · ${stt.name} raw STT hidden · ${audioSource} · ${engine.config.provider} cleanup on pause`, false)
  } catch (e: any) {
    setStatus(`⚠ ${e.message}`, true)
  }
}

function stop() {
  engine.flush()
  stt?.stop()
  running = false
  toggleBtn.textContent = 'Start'
  toggleBtn.classList.remove('recording')
  setStatus('Stopped', false)
}

function setStatus(msg: string, isError: boolean) {
  statusEl.textContent = msg
  statusEl.classList.toggle('error', isError)
}

// initial paint
renderCleanedTranscript(transcriptEl, engine.segments, null, false)
latency.render(latencyEl)
setStatus('Ready · Soniox raw STT → Groq cleaned transcript on pause', false)
