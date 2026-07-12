// Stable STT contract. Unit 1 uses it now; the integrated demo imports the
// same interface so swapping providers never touches UI code.
export interface TranscriptEvent {
  /** For a final result: a newly-finalized chunk. For interim: the current hypothesis. */
  text: string
  isFinal: boolean
  /** performance.now() when this text reached the browser. */
  timestamp: number
  /** Detected BCP-47-ish language code when the provider reports one. */
  language?: string
  /** Diarized speaker tag ('S1', 'S2', …) when the provider identifies one. */
  speaker?: string
}

export interface STTStartOpts {
  /** BCP-47 language hint, e.g. 'en-US' or 'zh-CN'; 'auto' asks the provider to detect it. */
  lang: string
  /** Pre-acquired audio stream (mic / system / both). If omitted, mic is used. */
  stream?: MediaStream
}

export interface STTProvider {
  readonly name: string
  start(opts: STTStartOpts): Promise<void>
  stop(): void | Promise<void>
  onTranscript(cb: (e: TranscriptEvent) => void): void
  onError(cb: (err: Error) => void): void
}
