import { describe, expect, it } from 'vitest'
import { mediaTypeForFile, mediaTypeForSource, placeDroppedImage } from './image-drop-placement'

describe('placeDroppedImage', () => {
  it('centers a landscape image exactly on the pointer drop point', () => {
    const placed = placeDroppedImage(500, 300, 800, 400)
    expect(placed).toEqual({ x: 340, y: 220, w: 320 })
    expect(placed.x + placed.w / 2).toBe(500)
    expect(placed.y + (placed.w * 400 / 800) / 2).toBe(300)
  })

  it('centers a portrait image without changing its ratio', () => {
    expect(placeDroppedImage(200, 250, 300, 600)).toEqual({
      x: 40,
      y: -70,
      w: 320
    })
  })
})

describe('media type detection', () => {
  it('distinguishes still images, animated GIFs, and video files', () => {
    expect(mediaTypeForFile({ name: 'photo.png', type: 'image/png' })).toBe('image')
    expect(mediaTypeForFile({ name: 'reaction.gif', type: 'image/gif' })).toBe('gif')
    expect(mediaTypeForFile({ name: 'demo.mp4', type: 'video/mp4' })).toBe('video')
    expect(mediaTypeForFile({ name: 'demo.webm', type: '' })).toBe('video')
    expect(mediaTypeForFile({ name: 'notes.txt', type: 'text/plain' })).toBeNull()
  })

  it('infers legacy GIF/video records from their source while honoring persisted metadata', () => {
    expect(mediaTypeForSource('data:image/gif;base64,AA')).toBe('gif')
    expect(mediaTypeForSource('https://example.com/movie.mp4?raw=1')).toBe('video')
    expect(mediaTypeForSource('https://example.com/opaque', 'video')).toBe('video')
    expect(mediaTypeForSource('data:image/png;base64,AA')).toBe('image')
  })
})
