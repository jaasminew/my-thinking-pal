// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandSidePanel } from './CommandSidePanel'

afterEach(cleanup)

describe('CommandSidePanel sources', () => {
  it('renders validated web and knowledge sources with link styling and a favicon', () => {
    render(
      <CommandSidePanel
        session={{
          id: 's1',
          source: null,
          title: 'AI command',
          createdAt: 1,
          messages: [{
            id: 'm1',
            role: 'assistant',
            text: '**Grounded answer.**\n\n| Feature | Benefit |\n| --- | --- |\n| Memory | Context |',
            sources: [
              { kind: 'knowledge', id: 'f1', title: 'Canvas brief' },
              { kind: 'web', title: 'Example Research', url: 'https://example.com/research' }
            ]
          }]
        }}
        streaming={false}
        onSend={vi.fn()}
        onApplyAction={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('Canvas brief').parentElement?.classList.contains('cmd-source-link')).toBe(true)
    expect(screen.getByText('Canvas brief').parentElement?.classList.contains('knowledge')).toBe(true)
    expect(screen.getByText('Canvas brief').parentElement?.querySelector('svg.cmd-source-file')).toBeTruthy()
    const web = screen.getByRole('link', { name: 'Example Research' })
    expect(web.classList.contains('cmd-source-link')).toBe(true)
    expect(web.getAttribute('href')).toBe('https://example.com/research')
    expect(web.querySelector('img')?.getAttribute('src')).toContain('example.com')
    expect(screen.getByText('Grounded answer.').tagName).toBe('STRONG')
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Feature' })).toBeTruthy()
  })
})
