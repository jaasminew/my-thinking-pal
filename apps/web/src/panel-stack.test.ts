import { describe, expect, it } from 'vitest'
import { insetAdjustedPanelWidth, PANEL_HANDLE_WIDTH, resolvePanelWidths } from './panel-stack'

describe('stacked canvas widths', () => {
  it('subtracts both workspace insets from the panel area', () => {
    expect(insetAdjustedPanelWidth(1200, 8)).toBe(1184)
  })

  it('keeps a full handle between maximally expanded adjacent canvases', () => {
    const [underneath, upper] = resolvePanelWidths([1, 1], 1184)

    expect(underneath - upper).toBe(PANEL_HANDLE_WIDTH)
    expect(upper).toBe(underneath - PANEL_HANDLE_WIDTH)
  })

  it('applies the same invariant against the actual sheet underneath', () => {
    const widths = resolvePanelWidths([0.82, 1, 1], 1184)

    expect(widths[0] - widths[1]).toBe(PANEL_HANDLE_WIDTH)
    expect(widths[1] - widths[2]).toBe(PANEL_HANDLE_WIDTH)
  })
})
