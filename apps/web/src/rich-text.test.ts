import { describe, expect, it } from 'vitest'
import { applyTextStyle, joinRuns, remapRunsForTextChange, sliceRuns, splitRuns } from './rich-text'

describe('rich text ranges', () => {
  it('applies independent styles to only the selected characters', () => {
    let runs = applyTextStyle([], 10, 2, 7, { weight: 700 })
    runs = applyTextStyle(runs, 10, 4, 6, { color: '#e34a33' })
    expect(runs).toEqual([
      { start: 2, end: 4, weight: 700 },
      { start: 4, end: 6, color: '#e34a33', weight: 700 },
      { start: 6, end: 7, weight: 700 }
    ])
  })

  it('extends a style when text is typed inside its range', () => {
    expect(remapRunsForTextChange(
      [{ start: 1, end: 4, weight: 700 }],
      'abcde',
      'abXXcde'
    )).toEqual([{ start: 1, end: 6, weight: 700 }])
  })

  it('splits, slices, and rejoins formatting across paragraph edits', () => {
    const runs = [{ start: 1, end: 5, size: 18 }]
    const [left, right] = splitRuns(runs, 3)
    expect(left).toEqual([{ start: 1, end: 3, size: 18 }])
    expect(right).toEqual([{ start: 0, end: 2, size: 18 }])
    expect(joinRuns(left, 3, sliceRuns(right, 1, 2), 1)).toEqual([
      { start: 1, end: 4, size: 18 }
    ])
  })
})
