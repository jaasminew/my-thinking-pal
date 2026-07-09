// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProjectMemoryModal } from './ProjectMemoryModal'
import type {
  ProjectInstructions,
  ProjectMemoryFile,
  ProjectMemoryModalProps
} from '../../../services/project-memory/types'

afterEach(cleanup)

const instructions: ProjectInstructions = {
  transcriptionSummary: 'summarize the transcript',
  coCreation: 'co-create concisely',
  aiCommand: 'answer with bullets'
}

const file = (id: string, over: Partial<ProjectMemoryFile> = {}): ProjectMemoryFile => ({
  id,
  scopeKind: 'space',
  scopeId: 's1',
  name: `${id}.md`,
  mimeType: 'text/markdown',
  size: 1024,
  title: `Title ${id}`,
  description: `Desc ${id}`,
  status: 'indexed',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over
})

const baseProps = (over: Partial<ProjectMemoryModalProps> = {}): ProjectMemoryModalProps => ({
  scopeName: 'Project A',
  files: [],
  instructions,
  busy: false,
  instructionsSaved: true,
  error: null,
  onUpload: vi.fn(),
  onDeleteFile: vi.fn(),
  onRetryFile: vi.fn(),
  onSaveInstructions: vi.fn(),
  onClose: vi.fn(),
  ...over
})

describe('ProjectMemoryModal — file rows', () => {
  it('renders one row per file with title, description, status, and size', () => {
    const props = baseProps({
      files: [
        file('f1', { title: 'PRD v2', description: 'Product spec', status: 'indexed', size: 2048 }),
        file('f2', { title: 'Notes', description: 'Meeting notes', status: 'extracting', size: 512 })
      ]
    })
    render(<ProjectMemoryModal {...props} />)

    expect(screen.getByText('PRD v2')).toBeTruthy()
    expect(screen.getByText('Product spec')).toBeTruthy()
    expect(screen.getByText('Indexed')).toBeTruthy()
    expect(screen.getByText('Notes')).toBeTruthy()
    expect(screen.getByText('Extracting…')).toBeTruthy()
    // size formatting
    expect(screen.getByText('2.0 KB')).toBeTruthy()
    expect(screen.getByText('512 B')).toBeTruthy()
  })

  it('a failed row shows retry + delete; an indexed row shows delete only', () => {
    const props = baseProps({
      files: [
        file('ok', { title: 'Good Doc', status: 'indexed' }),
        file('bad', { title: 'Broken Doc', status: 'failed', error: 'oops' })
      ]
    })
    render(<ProjectMemoryModal {...props} />)

    // failed row has both retry and delete
    expect(screen.getByLabelText('Retry Broken Doc')).toBeTruthy()
    expect(screen.getByLabelText('Delete Broken Doc')).toBeTruthy()
    // indexed row has delete but no retry
    expect(screen.getByLabelText('Delete Good Doc')).toBeTruthy()
    expect(screen.queryByLabelText('Retry Good Doc')).toBeNull()
  })
})

describe('ProjectMemoryModal — instructions tabs', () => {
  it('switching tabs swaps the textarea content', () => {
    render(<ProjectMemoryModal {...baseProps()} />)

    // Starts on Transcription summary.
    let ta = screen.getByLabelText('Transcription summary') as HTMLTextAreaElement
    expect(ta.value).toBe('summarize the transcript')

    // Switch to AI co-creation.
    fireEvent.click(screen.getByRole('tab', { name: 'AI co-creation' }))
    ta = screen.getByLabelText('AI co-creation') as HTMLTextAreaElement
    expect(ta.value).toBe('co-create concisely')

    // Switch to AI command.
    fireEvent.click(screen.getByRole('tab', { name: 'AI command' }))
    ta = screen.getByLabelText('AI command') as HTMLTextAreaElement
    expect(ta.value).toBe('answer with bullets')
  })

  it('preserves edits across tab switches', () => {
    render(<ProjectMemoryModal {...baseProps()} />)

    const ta = screen.getByLabelText('Transcription summary') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'edited summary' } })

    // Leave and come back; the edit survives.
    fireEvent.click(screen.getByRole('tab', { name: 'AI co-creation' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Transcription summary' }))
    expect((screen.getByLabelText('Transcription summary') as HTMLTextAreaElement).value).toBe('edited summary')
  })

  it('shows a visible saved-state indicator', () => {
    const { getByTestId } = render(<ProjectMemoryModal {...baseProps({ instructionsSaved: true })} />)
    expect(getByTestId('saved-indicator').textContent).toBe('Saved')
  })

  it('marks unsaved changes when the textarea is edited', () => {
    const { getByTestId } = render(<ProjectMemoryModal {...baseProps({ instructionsSaved: true })} />)
    const ta = screen.getByLabelText('Transcription summary') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'changed' } })
    expect(getByTestId('saved-indicator').textContent).toBe('Unsaved changes')
  })
})

describe('ProjectMemoryModal — callbacks fire on click', () => {
  it('fires onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    render(<ProjectMemoryModal {...baseProps({ onClose })} />)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('fires onDeleteFile with the file id', () => {
    const onDeleteFile = vi.fn()
    render(
      <ProjectMemoryModal
        {...baseProps({ files: [file('f1', { title: 'Doc One', status: 'indexed' })], onDeleteFile })}
      />
    )
    fireEvent.click(screen.getByLabelText('Delete Doc One'))
    expect(onDeleteFile).toHaveBeenCalledWith('f1')
  })

  it('fires onRetryFile with the file id for a failed row', () => {
    const onRetryFile = vi.fn()
    render(
      <ProjectMemoryModal
        {...baseProps({ files: [file('f2', { title: 'Bad Doc', status: 'failed' })], onRetryFile })}
      />
    )
    fireEvent.click(screen.getByLabelText('Retry Bad Doc'))
    expect(onRetryFile).toHaveBeenCalledWith('f2')
  })

  it('fires onSaveInstructions with the current draft', () => {
    const onSaveInstructions = vi.fn()
    render(<ProjectMemoryModal {...baseProps({ onSaveInstructions })} />)
    fireEvent.change(screen.getByLabelText('Transcription summary'), {
      target: { value: 'new summary' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }))
    expect(onSaveInstructions).toHaveBeenCalledTimes(1)
    const passed = onSaveInstructions.mock.calls[0][0] as ProjectInstructions
    expect(passed.transcriptionSummary).toBe('new summary')
    // untouched fields are preserved
    expect(passed.coCreation).toBe('co-create concisely')
    expect(passed.aiCommand).toBe('answer with bullets')
  })

  it('fires onUpload when files are picked via the file input', () => {
    const onUpload = vi.fn()
    render(<ProjectMemoryModal {...baseProps({ onUpload })} />)
    const input = screen.getByLabelText('Upload files') as HTMLInputElement
    const f = new File(['hello'], 'note.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [f] } })
    expect(onUpload).toHaveBeenCalledTimes(1)
    expect(onUpload.mock.calls[0][0]).toHaveLength(1)
    expect((onUpload.mock.calls[0][0][0] as File).name).toBe('note.txt')
  })
})

describe('ProjectMemoryModal — error banner', () => {
  it('renders the error banner when error is non-null', () => {
    render(<ProjectMemoryModal {...baseProps({ error: 'upload failed' })} />)
    expect(screen.getByRole('alert').textContent).toBe('upload failed')
  })

  it('renders no alert when error is null', () => {
    render(<ProjectMemoryModal {...baseProps({ error: null })} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
