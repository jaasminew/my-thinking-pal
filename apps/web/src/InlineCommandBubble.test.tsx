// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InlineCommandBubble } from './InlineCommandBubble'

afterEach(cleanup)

describe('InlineCommandBubble', () => {
  it('uses the caller-provided anchor and placeholder and submits with Enter', () => {
    const onSubmit = vi.fn()
    const { container } = render(
      <InlineCommandBubble
        anchor={{ top: 120, left: 80, width: 0, height: 0 }}
        placeholder="Ask AI anything…"
        onSubmit={onSubmit}
        onDismiss={vi.fn()}
      />
    )
    const bubble = container.querySelector<HTMLElement>('.cmd-bubble')!
    expect(bubble.style.left).toBe('80px')
    expect(bubble.style.top).toBe('130px')
    const input = screen.getByPlaceholderText('Ask AI anything…')
    fireEvent.change(input, { target: { value: '  make a note  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('make a note')
  })

  it('dismisses with Escape', () => {
    const onDismiss = vi.fn()
    render(
      <InlineCommandBubble
        anchor={{ top: 20, left: 20, width: 10, height: 10 }}
        placeholder="Ask AI about this…"
        onSubmit={vi.fn()}
        onDismiss={onDismiss}
      />
    )
    fireEvent.keyDown(screen.getByPlaceholderText('Ask AI about this…'), { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
