// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LlmSettingsPanel } from './LlmSettingsPanel'

describe('LlmSettingsPanel', () => {
  it('shows an unconfigured state instead of starter model entries', () => {
    render(
      <LlmSettingsPanel
        configs={[]}
        selections={{ listener: '', thinker: '' }}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getAllByRole('option', { name: 'No model configured' })).toHaveLength(2)
    expect(screen.queryByText('Groq · GPT-OSS 120B')).toBeNull()
    expect(screen.getAllByRole('button', { name: '+ New Model' })).toHaveLength(2)
  })
})
