// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { EditableImage, proportionalImageResize, safeImageUrl } from './EditableImage'

afterEach(cleanup)

describe('EditableImage', () => {
  it('normalizes safe web URLs and rejects unsafe schemes', () => {
    expect(safeImageUrl('example.com/page')).toBe('https://example.com/page')
    expect(safeImageUrl('javascript:alert(1)')).toBeNull()
    expect(safeImageUrl('file:///tmp/a')).toBeNull()
  })

  it('requires removing the one existing URL before a new one can be attached', () => {
    function Harness() {
      const [url, setUrl] = useState<string | undefined>('https://old.example/')
      return (
        <EditableImage
          src="data:image/png;base64,AA"
          url={url}
          width={200}
          selected
          scale={1}
          onOpen={vi.fn()}
          onResize={vi.fn()}
          onUrlChange={setUrl}
          onSummon={vi.fn()}
        />
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByLabelText('Attached URL'))
    expect(screen.queryByPlaceholderText('https://…')).toBeNull()
    fireEvent.click(screen.getByText('Remove'))
    fireEvent.click(screen.getByLabelText('Attach URL'))
    const input = screen.getByPlaceholderText('https://…')
    fireEvent.change(input, { target: { value: 'new.example/path' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByLabelText('Attached URL')).toBeTruthy()
  })

  it('resizes proportionally from every edge and corner', () => {
    // 2:1 image: 20px down on the bottom edge adds 40px of width.
    expect(proportionalImageResize('bottom', 200, 100, 0, 20, 1)).toEqual({
      width: 240,
      shiftX: -20,
      shiftY: 0
    })
    // The opposite edge midpoint stays anchored as the image grows.
    expect(proportionalImageResize('left', 200, 100, -30, 0, 1)).toEqual({
      width: 230,
      shiftX: -30,
      shiftY: -7.5
    })
    expect(proportionalImageResize('br', 200, 100, 10, 20, 1)).toEqual({
      width: 240,
      shiftX: 0,
      shiftY: 0
    })
    // Dragging top-left keeps the bottom-right vertex fixed.
    expect(proportionalImageResize('tl', 200, 100, -40, -20, 1)).toEqual({
      width: 240,
      shiftX: -40,
      shiftY: -20
    })
  })

  it('renders sensitive drag targets on all four edges and corners', () => {
    const { container } = render(
      <EditableImage
        src="data:image/png;base64,AA"
        width={200}
        selected
        scale={1}
        onOpen={vi.fn()}
        onResize={vi.fn()}
        onUrlChange={vi.fn()}
        onSummon={vi.fn()}
      />
    )
    expect(container.querySelectorAll('.image-resize-edge')).toHaveLength(4)
    expect(container.querySelectorAll('.image-resize')).toHaveLength(4)
  })

  it('selects on one click and opens the preview only on double-click', () => {
    const onOpen = vi.fn()
    const { container } = render(
      <EditableImage
        src="data:image/png;base64,AA"
        width={200}
        scale={1}
        onOpen={onOpen}
        onResize={vi.fn()}
        onUrlChange={vi.fn()}
        onSummon={vi.fn()}
      />
    )
    const image = container.querySelector('img')!
    fireEvent.pointerDown(image, { clientX: 20, clientY: 20 })
    fireEvent.pointerUp(document)
    fireEvent.click(image)
    expect(container.querySelector('.editable-image')?.classList.contains('selected')).toBe(true)
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.doubleClick(image)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('renders GIFs as autoplaying image content without video controls', () => {
    const { container } = render(
      <EditableImage
        src="data:image/gif;base64,AA"
        mediaType="gif"
        width={200}
        scale={1}
        onOpen={vi.fn()}
        onResize={vi.fn()}
        onUrlChange={vi.fn()}
        onSummon={vi.fn()}
      />
    )
    expect(container.querySelector('img')).toBeTruthy()
    expect(container.querySelector('video')).toBeNull()
    expect(screen.queryByLabelText('Play video')).toBeNull()
  })

  it('selects a video on click, plays in place from its overlay, and previews only on double-click', async () => {
    const onOpen = vi.fn()
    const { container } = render(
      <EditableImage
        src="data:video/mp4;base64,AA"
        mediaType="video"
        title="Demo"
        width={200}
        scale={1}
        onOpen={onOpen}
        onResize={vi.fn()}
        onUrlChange={vi.fn()}
        onSummon={vi.fn()}
      />
    )
    const video = container.querySelector('video')!
    let paused = true
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused })
    video.play = vi.fn(async () => { paused = false; fireEvent.play(video) })
    video.pause = vi.fn(() => { paused = true; fireEvent.pause(video) })

    fireEvent.pointerDown(video, { clientX: 20, clientY: 20 })
    fireEvent.pointerUp(document)
    fireEvent.click(video)
    expect(container.querySelector('.editable-image')?.classList.contains('selected')).toBe(true)
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('Play video'))
    expect(video.play).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Pause video')).toBeTruthy()

    fireEvent.doubleClick(video)
    expect(video.pause).toHaveBeenCalledOnce()
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('moves an in-note image and adds continuous top/left magnetic resistance', () => {
    const onMove = vi.fn()
    const { container } = render(
      <div className="canvas-layer">
        <EditableImage
          className="moving-image"
          src="data:image/png;base64,AA"
          width={200}
          scale={1}
          onOpen={vi.fn()}
          onMove={onMove}
          onResize={vi.fn()}
          onUrlChange={vi.fn()}
          onSummon={vi.fn()}
        />
        <div className="editable-image alignment-candidate" />
      </div>
    )
    const frame = container.querySelector<HTMLElement>('.moving-image')!
    const candidate = container.querySelector<HTMLElement>('.alignment-candidate')!
    frame.getBoundingClientRect = () => ({
      x: 100, y: 100, left: 100, top: 100, right: 300, bottom: 200,
      width: 200, height: 100, toJSON: () => ({})
    } as DOMRect)
    candidate.getBoundingClientRect = () => ({
      x: 150, y: 400, left: 150, top: 400, right: 350, bottom: 500,
      width: 200, height: 100, toJSON: () => ({})
    } as DOMRect)

    const image = frame.querySelector('img')!
    fireEvent.pointerDown(image, { clientX: 120, clientY: 120 })
    fireEvent.pointerMove(document, { clientX: 169, clientY: 150 })
    const [magneticX, rawY] = onMove.mock.calls.at(-1) as [number, number]
    expect(magneticX).toBeGreaterThan(49)
    expect(magneticX).toBeLessThan(50)
    expect(rawY).toBe(30)

    // Moving beyond the aligned left edge is resisted, never locked.
    fireEvent.pointerMove(document, { clientX: 171, clientY: 150 })
    const [releasedX] = onMove.mock.calls.at(-1) as [number, number]
    expect(releasedX).toBeGreaterThan(50)
    expect(releasedX).toBeLessThan(51)
    fireEvent.pointerUp(document)
  })

  it('replaces the black toolbar while this image AI prompt is active', () => {
    render(
      <EditableImage
        src="data:image/png;base64,AA"
        width={200}
        selected
        aiPromptActive
        scale={1}
        onOpen={vi.fn()}
        onResize={vi.fn()}
        onUrlChange={vi.fn()}
        onSummon={vi.fn()}
      />
    )
    expect(screen.queryByLabelText('Attach URL')).toBeNull()
    expect(screen.queryByLabelText('Summon AI')).toBeNull()
  })

  it('adds continuous height resistance without disabling the first resize movement', () => {
    const onResize = vi.fn()
    const { container } = render(
      <EditableImage
        src="data:image/png;base64,AA"
        width={200}
        selected
        scale={1}
        onOpen={vi.fn()}
        onResize={onResize}
        getMagneticHeights={() => [120]}
        onUrlChange={vi.fn()}
        onSummon={vi.fn()}
      />
    )
    const frame = container.querySelector<HTMLElement>('.editable-image')!
    frame.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 100,
      width: 200, height: 100, toJSON: () => ({})
    } as DOMRect)
    const bottom = container.querySelector<HTMLElement>('.image-resize-edge.bottom')!

    fireEvent.pointerDown(bottom, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(document, { clientX: 100, clientY: 120 })
    expect(onResize).toHaveBeenLastCalledWith(240, -20, 0)

    // The first pixel beyond the matched height still enlarges the image.
    fireEvent.pointerMove(document, { clientX: 100, clientY: 121 })
    const resistedWidth = onResize.mock.calls.at(-1)?.[0] as number
    expect(resistedWidth).toBeGreaterThan(240)
    expect(resistedWidth).toBeLessThan(242)

    // At the magnetic radius, movement is back to 1:1.
    fireEvent.pointerMove(document, { clientX: 100, clientY: 136 })
    expect(onResize).toHaveBeenLastCalledWith(272, -36, 0)
    fireEvent.pointerUp(document)
  })
})
