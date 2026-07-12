import { useMemo, useState } from 'react'
import { applyTokenValues, defaultTokenValues, DESIGN_TOKEN_CHANNEL, DESIGN_TOKEN_STORAGE_KEY, designTokens, readTokenValues, type TokenValues } from './design-tokens'
import './design-system.css'

export function DesignSystemPage() {
  const [values, setValues] = useState<TokenValues>(() => readTokenValues())
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const filtered = designTokens.filter((token) => `${token.group} ${token.label} ${token.name}`.toLowerCase().includes(query.toLowerCase()))
    return Object.groupBy(filtered, (token) => token.group)
  }, [query])

  function update(name: string, value: string) {
    const next = { ...values, [name]: value }
    setValues(next)
    applyTokenValues(next)
    localStorage.setItem(DESIGN_TOKEN_STORAGE_KEY, JSON.stringify(next))
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(DESIGN_TOKEN_CHANNEL)
      channel.postMessage(next)
      channel.close()
    }
  }

  function reset() {
    const next = defaultTokenValues()
    setValues(next)
    localStorage.removeItem(DESIGN_TOKEN_STORAGE_KEY)
    applyTokenValues(next)
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(DESIGN_TOKEN_CHANNEL)
      channel.postMessage(next)
      channel.close()
    }
  }

  function elevationLevel(name: string, scale: string[]) {
    const exact = scale.indexOf(values[name])
    return exact >= 0 ? exact : Math.max(1, Math.round(scale.length / 2) - 1)
  }

  return <main className="ds-shell">
    <section className="ds-editor">
      <header className="ds-head">
        <div><span className="ds-eyebrow">Thinking Pal</span><h1>Design system</h1><p>Edit a token and watch the product update live.</p></div>
        <button className="button-secondary" onClick={reset}>Reset all</button>
      </header>
      <div className="ds-toolbar"><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tokens…" /><span>{designTokens.length} tokens</span></div>
      {!query && <section className="ds-button-specimen">
        <div className="ds-specimen-head"><span>Component</span><h2>Buttons</h2><p>Use hierarchy to communicate one clear action per context.</p></div>
        <div className="ds-button-row"><div><button className="button-primary" type="button">Primary</button><small>Main action</small></div><div><button className="button-secondary" type="button">Secondary</button><small>Alternative</small></div></div>
        <div className="ds-button-row"><div><button className="button-tertiary" type="button">Tertiary</button><small>Low emphasis</small></div><div><button className="button-negative" type="button">Negative</button><small>Destructive</small></div></div>
      </section>}
      <div className="ds-groups">
        {Object.entries(groups).map(([group, tokens]) => <section className="ds-group" key={group}>
          <h2>{group}</h2>
          {tokens?.map((token) => <label className="ds-token" key={token.name}>
            <span className="ds-token-meta"><strong>{token.label}</strong><code>{token.name}</code></span>
            <span className="ds-control">
              {token.kind === 'color' && <input type="color" value={values[token.name].slice(0, 7)} onChange={(e) => update(token.name, e.target.value)} />}
              {token.kind === 'number' && <input className="ds-range" type="range" min={token.min} max={token.max} step={token.step} value={values[token.name]} onChange={(e) => update(token.name, e.target.value)} />}
              {token.kind === 'shadow' && token.scale && <span className="ds-elevation-range"><input className="ds-range" aria-label={`${token.label} elevation level`} type="range" min="0" max={token.scale.length - 1} step="1" value={elevationLevel(token.name, token.scale)} onChange={(e) => update(token.name, token.scale![Number(e.target.value)])} /><b>{elevationLevel(token.name, token.scale)}</b></span>}
              <input className="ds-value" value={values[token.name]} onChange={(e) => update(token.name, e.target.value)} /><em>{token.unit}</em>
            </span>
          </label>)}
        </section>)}
      </div>
    </section>
    <section className="ds-preview"><div className="ds-preview-bar"><span><i /> Live product</span><a href="/" target="_blank">Open in new tab ↗</a></div><iframe title="Thinking Pal live preview" src="/" /></section>
  </main>
}
