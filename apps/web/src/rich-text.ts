import type { TextStyleRun } from './canvas-types'

export type TextStylePatch = {
  color?: string | null
  size?: number | null
  weight?: 400 | 600 | 700 | null
}

const sameStyle = (a: TextStyleRun, b: TextStyleRun) =>
  a.color === b.color && a.size === b.size && a.weight === b.weight

const hasStyle = (r: TextStyleRun) => !!(r.color || r.size || r.weight)

export function normalizeRuns(runs: TextStyleRun[] | undefined, textLength: number): TextStyleRun[] {
  const safe = (runs ?? [])
    .map((r) => ({
      start: Math.max(0, Math.min(textLength, Math.floor(r.start))),
      end: Math.max(0, Math.min(textLength, Math.floor(r.end))),
      ...(r.color ? { color: r.color } : {}),
      ...(r.size ? { size: r.size } : {}),
      ...(r.weight ? { weight: r.weight } : {})
    }))
    .filter((r) => r.end > r.start && hasStyle(r))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const out: TextStyleRun[] = []
  for (const run of safe) {
    const prev = out[out.length - 1]
    if (prev && prev.end === run.start && sameStyle(prev, run)) prev.end = run.end
    else out.push(run)
  }
  return out
}

const styleAt = (runs: TextStyleRun[], pos: number): Omit<TextStyleRun, 'start' | 'end'> => {
  const r = runs.find((x) => x.start <= pos && x.end > pos)
  return r ? { color: r.color, size: r.size, weight: r.weight } : {}
}

export function applyTextStyle(
  runs: TextStyleRun[] | undefined,
  textLength: number,
  start: number,
  end: number,
  patch: TextStylePatch
): TextStyleRun[] {
  const a = Math.max(0, Math.min(textLength, start))
  const b = Math.max(a, Math.min(textLength, end))
  if (a === b) return normalizeRuns(runs, textLength)
  const current = normalizeRuns(runs, textLength)
  const bounds = new Set<number>([0, textLength, a, b])
  current.forEach((r) => { bounds.add(r.start); bounds.add(r.end) })
  const points = [...bounds].sort((x, y) => x - y)
  const out: TextStyleRun[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i], to = points[i + 1]
    if (to <= from) continue
    const base = styleAt(current, from)
    const selected = from < b && to > a
    const next = selected
      ? {
          color: patch.color === null ? undefined : patch.color ?? base.color,
          size: patch.size === null ? undefined : patch.size ?? base.size,
          weight: patch.weight === null ? undefined : patch.weight ?? base.weight
        }
      : base
    const run: TextStyleRun = { start: from, end: to, ...next }
    if (!hasStyle(run)) continue
    const prev = out[out.length - 1]
    if (prev && prev.end === run.start && sameStyle(prev, run)) prev.end = run.end
    else out.push(run)
  }
  return out
}

/** Preserve styling around the single contiguous edit produced by an input event. */
export function remapRunsForTextChange(
  runs: TextStyleRun[] | undefined,
  oldText: string,
  newText: string
): TextStyleRun[] {
  if (oldText === newText) return normalizeRuns(runs, newText.length)
  let prefix = 0
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix++
  let suffix = 0
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) suffix++
  const oldEnd = oldText.length - suffix
  const newEnd = newText.length - suffix
  const delta = newText.length - oldText.length
  const remapped = normalizeRuns(runs, oldText.length)
    .map((r): TextStyleRun | null => {
      if (r.end <= prefix) return r
      if (r.start >= oldEnd) return { ...r, start: r.start + delta, end: r.end + delta }
      const start = Math.min(r.start, prefix)
      const end = Math.max(prefix, r.end + delta, newEnd)
      return end > start ? { ...r, start, end } : null
    })
    .filter((r): r is TextStyleRun => !!r)
  return normalizeRuns(remapped, newText.length)
}

export function splitRuns(runs: TextStyleRun[] | undefined, at: number): [TextStyleRun[], TextStyleRun[]] {
  const left: TextStyleRun[] = []
  const right: TextStyleRun[] = []
  for (const r of runs ?? []) {
    if (r.start < at) left.push({ ...r, end: Math.min(r.end, at) })
    if (r.end > at) right.push({ ...r, start: Math.max(0, r.start - at), end: r.end - at })
  }
  return [normalizeRuns(left, at), normalizeRuns(right, Number.MAX_SAFE_INTEGER)]
}

export function joinRuns(
  left: TextStyleRun[] | undefined,
  leftLength: number,
  right: TextStyleRun[] | undefined,
  rightLength: number
): TextStyleRun[] {
  return normalizeRuns(
    [...(left ?? []), ...(right ?? []).map((r) => ({ ...r, start: r.start + leftLength, end: r.end + leftLength }))],
    leftLength + rightLength
  )
}

export function sliceRuns(
  runs: TextStyleRun[] | undefined,
  start: number,
  end: number
): TextStyleRun[] {
  const length = Math.max(0, end - start)
  return normalizeRuns(
    (runs ?? [])
      .filter((r) => r.end > start && r.start < end)
      .map((r) => ({
        ...r,
        start: Math.max(0, r.start - start),
        end: Math.min(length, r.end - start)
      })),
    length
  )
}
