// Captures the full-chain latency sample that is the deliverable for Vandark.
// Headline number = transcript-final -> cleaned/highlighted segment rendered.
export interface LatencySample {
  /** transcript-final -> cleaned/highlighted segment rendered, ms (the headline). */
  total: number
  /** how long finalized words waited for the pause cadence to fire, ms. */
  cadenceWait: number
  /** model round-trip, ms. */
  llm: number
  model?: string
}

export class LatencyTracker {
  private samples: number[] = []
  private last?: LatencySample

  record(s: LatencySample) {
    this.samples.push(s.total)
    if (this.samples.length > 200) this.samples.shift()
    this.last = s
  }

  private pct(p: number): number {
    if (!this.samples.length) return 0
    const sorted = [...this.samples].sort((a, b) => a - b)
    const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
    return Math.round(sorted[i])
  }

  render(el: HTMLElement) {
    const l = this.last
    const aliveClass = l && l.total <= 1500 ? 'good' : l ? 'warn' : ''
    el.innerHTML = `
      <div class="lat-head ${aliveClass}">
        <span class="lat-big">${l ? Math.round(l.total) : '–'}</span><span class="lat-unit">ms</span>
        <span class="lat-label">final transcript &rarr; cleaned render (last)</span>
      </div>
      <div class="lat-grid">
        <div><b>${this.pct(50)}</b><span>p50</span></div>
        <div><b>${this.pct(95)}</b><span>p95</span></div>
        <div><b>${l ? Math.round(l.llm) : '–'}</b><span>model ms</span></div>
        <div><b>${l ? Math.round(l.cadenceWait) : '–'}</b><span>pause wait</span></div>
        <div><b>${this.samples.length}</b><span>calls</span></div>
        <div><b>${l?.model ?? '–'}</b><span>model</span></div>
      </div>
      <div class="lat-note">Target: cleaned thoughts should appear shortly after a natural pause.
      Raw STT is hidden; this measures STT-final &rarr; cleanup/highlight render.</div>`
  }

  reset() {
    this.samples = []
    this.last = undefined
  }
}
