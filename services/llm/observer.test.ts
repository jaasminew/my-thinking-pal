import { describe, it, expect } from 'vitest'
import { requestObserverEvaluate, requestObserverContribute, MAX_SOURCE_CARDS } from './observer'
import type { ObserverServiceDeps } from './observer'
import type { CategoryResolution } from './model-roles'
import type { LlmProvider, UrlCard } from '../../packages/core/llm'
import type {
  ObserverContributorInput,
  ObserverDecision,
  ObserverEvaluatorInput
} from '../../packages/core/llm/observer-types'

const webProvider: LlmProvider = {
  id: 'groq',
  label: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: 'k',
  model: 'openai/gpt-oss-120b',
  kind: 'openai-compatible'
}

const evalInput: ObserverEvaluatorInput = {
  signals: [{ text: 's', ts: 1 }],
  canvasSummary: '',
  recentObserverTopics: [],
  kept: [],
  rejected: []
}

const contribInput: ObserverContributorInput = {
  decision: { emit: true, confidence: 0.8, opportunityType: 'source', topic: 't', needsResearch: true },
  signals: [{ text: 's', ts: 1 }],
  canvasSummary: ''
}

const decision: ObserverDecision = {
  emit: true,
  confidence: 0.8,
  opportunityType: 'missing-angle',
  topic: 'offline conflicts'
}

// A resolveCategory seam that returns the given resolution for each category.
function resolver(map: { listener?: CategoryResolution; thinker?: CategoryResolution }) {
  return async (category: 'listener' | 'thinker') =>
    (category === 'listener' ? map.listener : map.thinker) ?? { error: 'none' }
}

function card(n: number): UrlCard {
  return { title: `r${n}`, url: `https://example.com/${n}` }
}

describe('requestObserverEvaluate', () => {
  it('resolves the Listener and returns the decision', async () => {
    const deps: ObserverServiceDeps = {
      resolveCategory: resolver({ listener: { provider: webProvider } }),
      evaluatePass: async () => ({ decision, serverMs: 5, model: webProvider.model })
    }
    expect(await requestObserverEvaluate(evalInput, deps)).toEqual(decision)
  })

  it('returns null (surfaces nothing to emit) when the Listener is unavailable', async () => {
    const deps: ObserverServiceDeps = {
      resolveCategory: resolver({ listener: { error: 'no listener' } }),
      evaluatePass: async () => ({ decision, serverMs: 0 })
    }
    expect(await requestObserverEvaluate(evalInput, deps)).toBeNull()
  })

  it('passes null through on a failed evaluator pass', async () => {
    const deps: ObserverServiceDeps = {
      resolveCategory: resolver({ listener: { provider: webProvider } }),
      evaluatePass: async () => ({ decision: null, serverMs: 0, error: 'boom' })
    }
    expect(await requestObserverEvaluate(evalInput, deps)).toBeNull()
  })
})

describe('requestObserverContribute — web Thinker', () => {
  const baseContribution = { keyword: 'Offline sync', bullets: ['a', 'b'], searchQuery: 'crdt sync' }

  it('relays the SEARCH query and caps sources at MAX_SOURCE_CARDS', async () => {
    let askedQuery = ''
    const deps: ObserverServiceDeps = {
      relayAvailable: true,
      resolveCategory: resolver({ thinker: { provider: webProvider } }),
      contributePass: async () => ({ contribution: baseContribution, serverMs: 5, model: webProvider.model }),
      searchWebImpl: (async (q: string, n: number) => {
        askedQuery = q
        return [card(1), card(2), card(3), card(4), card(5)]
      }) as any
    }
    const res = await requestObserverContribute(contribInput, deps)
    expect(askedQuery).toBe('crdt sync')
    expect(res?.searchPath).toBe('relay')
    expect(res?.sources).toHaveLength(MAX_SOURCE_CARDS)
    expect(res?.keyword).toBe('Offline sync')
  })

  it('drops invalid URLs from the relayed sources', async () => {
    const deps: ObserverServiceDeps = {
      relayAvailable: true,
      resolveCategory: resolver({ thinker: { provider: webProvider } }),
      contributePass: async () => ({ contribution: baseContribution, serverMs: 5 }),
      searchWebImpl: (async () => [
        { title: 'bad', url: 'not-a-url' },
        { title: 'ftp', url: 'ftp://x/y' },
        card(1)
      ]) as any
    }
    const res = await requestObserverContribute(contribInput, deps)
    expect(res?.sources).toEqual([card(1)])
  })

  it('yields empty sources (never fabricated) when search throws', async () => {
    const deps: ObserverServiceDeps = {
      relayAvailable: true,
      resolveCategory: resolver({ thinker: { provider: webProvider } }),
      contributePass: async () => ({ contribution: baseContribution, serverMs: 5 }),
      searchWebImpl: (async () => {
        throw new Error('relay down')
      }) as any
    }
    const res = await requestObserverContribute(contribInput, deps)
    expect(res?.searchPath).toBe('relay')
    expect(res?.sources).toEqual([])
  })

  it('uses searchPath "none" and no sources when the relay is unavailable', async () => {
    const deps: ObserverServiceDeps = {
      relayAvailable: false,
      resolveCategory: resolver({ thinker: { provider: webProvider } }),
      contributePass: async () => ({ contribution: baseContribution, serverMs: 5 })
    }
    const res = await requestObserverContribute(contribInput, deps)
    expect(res?.searchPath).toBe('none')
    expect(res?.sources).toEqual([])
  })

  it('does not search when the contribution has no SEARCH query', async () => {
    let searched = false
    const deps: ObserverServiceDeps = {
      relayAvailable: true,
      resolveCategory: resolver({ thinker: { provider: webProvider } }),
      contributePass: async () => ({ contribution: { keyword: 'k', bullets: ['a'] }, serverMs: 5 }),
      searchWebImpl: (async () => {
        searched = true
        return [card(1)]
      }) as any
    }
    const res = await requestObserverContribute(contribInput, deps)
    expect(searched).toBe(false)
    expect(res?.sources).toEqual([])
  })

  it('returns null on a failed contributor pass', async () => {
    const deps: ObserverServiceDeps = {
      resolveCategory: resolver({ thinker: { provider: webProvider } }),
      contributePass: async () => ({ contribution: null, serverMs: 0, error: 'boom' })
    }
    expect(await requestObserverContribute(contribInput, deps)).toBeNull()
  })
})

describe('requestObserverContribute — CLI Thinker', () => {
  it('runs the local runtime, parses the output, and surfaces no cards (cli-native)', async () => {
    let ranWith: any
    const deps: ObserverServiceDeps = {
      resolveCategory: resolver({ thinker: { runtime: 'claude-code', command: 'claude', model: 'opus' } }),
      runLocalPromptImpl: (async (req: any) => {
        ranWith = req
        return 'KEYWORD: Offline sync\n- CRDTs merge concurrent edits.\n- LWW loses data.'
      }) as any
    }
    const res = await requestObserverContribute(contribInput, deps)
    expect(ranWith.runtime).toBe('claude-code')
    expect(ranWith.command).toBe('claude')
    expect(res?.searchPath).toBe('cli-native')
    expect(res?.bullets).toEqual(['CRDTs merge concurrent edits.', 'LWW loses data.'])
    expect(res?.sources).toEqual([])
    expect(res?.model).toBe('opus')
  })

  it('returns null when the CLI transport throws', async () => {
    const deps: ObserverServiceDeps = {
      resolveCategory: resolver({ thinker: { runtime: 'codex', command: 'codex' } }),
      runLocalPromptImpl: (async () => {
        throw new Error('bridge down')
      }) as any
    }
    expect(await requestObserverContribute(contribInput, deps)).toBeNull()
  })

  it('returns null when CLI output is unparseable', async () => {
    const deps: ObserverServiceDeps = {
      resolveCategory: resolver({ thinker: { runtime: 'codex', command: 'codex' } }),
      runLocalPromptImpl: (async () => 'no keyword, just prose') as any
    }
    expect(await requestObserverContribute(contribInput, deps)).toBeNull()
  })
})

describe('requestObserverContribute — unresolved Thinker', () => {
  it('returns null when the Thinker category errors', async () => {
    const deps: ObserverServiceDeps = {
      resolveCategory: resolver({ thinker: { error: 'no thinker' } }),
      contributePass: async () => ({ contribution: { keyword: 'k', bullets: ['a'] }, serverMs: 0 })
    }
    expect(await requestObserverContribute(contribInput, deps)).toBeNull()
  })
})
