// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AiCursorOverlay } from './AiCursorOverlay'
import type { AiCursorState } from './ai-cursor-types'

afterEach(cleanup)

function makeState(overrides: Partial<AiCursorState> = {}): AiCursorState {
  return {
    activities: {},
    currentId: null,
    target: null,
    label: 'thinking',
    lastActivityAt: 0,
    visible: false,
    ...overrides
  }
}

describe('AiCursorOverlay', () => {
  it('renders null when target is null', () => {
    const { container } = render(
      <AiCursorOverlay state={makeState()} view={{ x: 0, y: 0, scale: 1 }} />
    )
    expect(container.querySelector('[data-testid="ai-cursor-overlay"]')).toBeNull()
  })

  it('renders null when not mounted (visible=false after fade)', () => {
    const state = makeState({ target: { x: 10, y: 10 }, visible: false })
    const { container } = render(
      <AiCursorOverlay state={state} view={{ x: 0, y: 0, scale: 1 }} />
    )
    expect(container.querySelector('[data-testid="ai-cursor-overlay"]')).toBeNull()
  })

  it('pill text is "AI pal · writing" for that label', () => {
    const state = makeState({
      target: { x: 0, y: 0 },
      label: 'writing',
      visible: true
    })
    render(<AiCursorOverlay state={state} view={{ x: 0, y: 0, scale: 1 }} />)
    expect(screen.getByText('AI pal · writing')).toBeTruthy()
  })

  it('pill text is "AI pal · thinking" for the default label', () => {
    const state = makeState({
      target: { x: 0, y: 0 },
      label: 'thinking',
      visible: true
    })
    render(<AiCursorOverlay state={state} view={{ x: 0, y: 0, scale: 1 }} />)
    expect(screen.getByText('AI pal · thinking')).toBeTruthy()
    const dots = screen.getByTestId('ai-cursor-thinking-dots')
    expect(dots.textContent).toBe('...')
    expect(dots.getAttribute('aria-hidden')).toBe('true')
  })

  it('does not render animated dots for non-thinking labels', () => {
    const state = makeState({ target: { x: 0, y: 0 }, label: 'writing', visible: true })
    render(<AiCursorOverlay state={state} view={{ x: 0, y: 0, scale: 1 }} />)
    expect(screen.queryByTestId('ai-cursor-thinking-dots')).toBeNull()
  })

  it('pill text is "AI pal · found sources" for that label', () => {
    const state = makeState({
      target: { x: 0, y: 0 },
      label: 'found sources',
      visible: true
    })
    render(<AiCursorOverlay state={state} view={{ x: 0, y: 0, scale: 1 }} />)
    expect(screen.getByText('AI pal · found sources')).toBeTruthy()
  })

  it('position math: world (100,50) with view {x:10,y:20,scale:2} → left 210, top 120', () => {
    const state = makeState({
      target: { x: 100, y: 50 },
      visible: true
    })
    const { container } = render(
      <AiCursorOverlay state={state} view={{ x: 10, y: 20, scale: 2 }} />
    )
    const el = container.querySelector('[data-testid="ai-cursor-overlay"]') as HTMLElement
    expect(el).toBeTruthy()
    expect(el.style.left).toBe('210px')
    expect(el.style.top).toBe('120px')
  })

  it('pointer-events: none present on the overlay element', () => {
    const state = makeState({
      target: { x: 0, y: 0 },
      visible: true
    })
    const { container } = render(
      <AiCursorOverlay state={state} view={{ x: 0, y: 0, scale: 1 }} />
    )
    const el = container.querySelector('[data-testid="ai-cursor-overlay"]') as HTMLElement
    expect(el).toBeTruthy()
    expect(el.classList.contains('ai-cursor-overlay')).toBe(true)
    // The CSS sets pointer-events: none; verify the class is applied (jsdom
    // doesn't compute CSS, so we check the class that carries the rule).
    expect(el.className).toContain('ai-cursor-overlay')
  })

  it('renders the SVG glyph with var(--accent) fill', () => {
    const state = makeState({
      target: { x: 0, y: 0 },
      visible: true
    })
    const { container } = render(
      <AiCursorOverlay state={state} view={{ x: 0, y: 0, scale: 1 }} />
    )
    const svg = container.querySelector('.ai-cursor-glyph')
    expect(svg).toBeTruthy()
    const path = svg?.querySelector('path')
    expect(path?.getAttribute('fill')).toBe('var(--accent)')
  })
})
