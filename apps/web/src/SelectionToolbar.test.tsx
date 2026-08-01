// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelectionToolbar } from './SelectionToolbar'

afterEach(cleanup)

const snapshot = {
  noteId: 'n1',
  selectedText: 'hello',
  segments: [{ itemId: 'b1', start: 0, end: 5, textAtCapture: 'hello' }],
  screenRect: { top: 100, left: 100, width: 60, height: 20 }
}

describe('SelectionToolbar', () => {
  it('shows the five approved actions and toggles the list command', () => {
    const onToggleBullets = vi.fn()
    render(
      <SelectionToolbar
        snapshot={snapshot}
        allBulleted={false}
        onFormat={vi.fn()}
        onToggleBullets={onToggleBullets}
        onSummon={vi.fn()}
      />
    )
    expect(screen.getByLabelText('Text color')).toBeTruthy()
    expect(screen.getByLabelText('Font size')).toBeTruthy()
    expect(screen.getByLabelText('Font weight')).toBeTruthy()
    expect(screen.getByLabelText('Bulleted list')).toBeTruthy()
    expect(screen.getByLabelText('Summon AI')).toBeTruthy()
    expect(screen.getByLabelText('Summon AI').querySelectorAll('path')).toHaveLength(1)
    expect(document.querySelector<HTMLElement>('.selection-toolbar')?.style.left).toBe('37px')
    fireEvent.click(screen.getByLabelText('Bulleted list'))
    expect(onToggleBullets).toHaveBeenCalledOnce()
  })
})
