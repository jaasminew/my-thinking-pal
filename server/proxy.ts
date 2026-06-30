import { ProxyAgent } from 'undici'

// Node's global fetch ignores HTTP(S)_PROXY env vars — it needs an explicit
// dispatcher. We build one only for paid hosted APIs (Groq/Cerebras/Deepgram);
// local Ollama and WebSpeech never touch it.
export function getDispatcher(): ProxyAgent | undefined {
  const url =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  return url ? new ProxyAgent(url) : undefined
}
