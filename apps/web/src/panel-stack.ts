export const PANEL_HANDLE_WIDTH = 44

/** Width available to right-pinned panels after applying equal CSS insets. */
export function insetAdjustedPanelWidth(workspaceWidth: number, inset: number): number {
  return Math.max(PANEL_HANDLE_WIDTH, workspaceWidth - inset * 2)
}

/** Resolve bottom-to-top sheet widths while keeping every buried handle visible. */
export function resolvePanelWidths(
  fractions: number[],
  availableWidth: number,
  handleWidth = PANEL_HANDLE_WIDTH
): number[] {
  const widths = fractions.map((fraction) => fraction * availableWidth)
  for (let index = 0; index < widths.length; index++) {
    const max = index === 0 ? availableWidth : widths[index - 1] - handleWidth
    widths[index] = Math.max(handleWidth, Math.min(widths[index], max))
  }
  return widths
}
