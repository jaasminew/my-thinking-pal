import { describe, expect, it } from 'vitest'
import { placeDroppedImage } from './image-drop-placement'

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
