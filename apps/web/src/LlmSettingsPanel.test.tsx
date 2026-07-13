// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LlmSettingsPanel, type AiModelConfig } from './LlmSettingsPanel'

const sampleConfigs: AiModelConfig[] = [
  {
    id: 'cfg-groq',
    label: 'Groq · GPT-OSS 120B',
    runtime: 'api',
    providerId: 'groq',
    model: 'openai/gpt-oss-120b',
    apiKey: 'gk-test'
  },
  {
    id: 'cfg-ds',
    label: 'DeepSeek · DeepSeek V4 Flash',
    runtime: 'api',
    providerId: 'deepseek',
    model: 'deepseek-v4-flash',
    apiKey: 'sk-test'
  }
]

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

  it('shows hosted DeepSeek defaults when signed in with empty selection', () => {
    render(
      <LlmSettingsPanel
        configs={[]}
        selections={{ listener: '', thinker: '' }}
        hostedAvailable
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByRole('option', { name: 'Hosted DeepSeek Flash' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Hosted DeepSeek Pro' })).toBeTruthy()
    expect(screen.getByText(/empty selection uses hosted DeepSeek/i)).toBeTruthy()
  })

  it('deletes a saved model and clears selections that pointed at it', () => {
    const onSave = vi.fn()
    render(
      <LlmSettingsPanel
        configs={sampleConfigs}
        selections={{ listener: 'cfg-groq', thinker: 'cfg-ds' }}
        onSave={onSave}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('Saved models')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2)

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])
    expect(screen.queryByText('Groq · GPT-OSS 120B')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1)
    expect(document.querySelector('.llm-saved-label')?.textContent).toBe('DeepSeek · DeepSeek V4 Flash')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(
      { listener: '', thinker: 'cfg-ds' },
      [sampleConfigs[1]]
    )
  })

  it('keeps hosted presets selectable after personal models are added', () => {
    render(
      <LlmSettingsPanel
        configs={sampleConfigs}
        selections={{ listener: 'cfg-groq', thinker: 'cfg-ds' }}
        hostedAvailable
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByRole('option', { name: 'Hosted DeepSeek Flash' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Hosted DeepSeek Pro' })).toBeTruthy()
    expect(screen.getAllByRole('option', { name: 'Groq · GPT-OSS 120B' }).length).toBeGreaterThan(0)
  })
})
