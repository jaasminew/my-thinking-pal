import { describe, expect, it } from 'vitest'
import { applyMagneticResistance } from './image-magnet'

describe('applyMagneticResistance', () => {
  it('always moves immediately while adding resistance near an alignment', () => {
    const onePixelPull = applyMagneticResistance(101, [100], 8, 0.45)
    expect(onePixelPull).toBeGreaterThan(100)
    expect(onePixelPull).toBeLessThan(101)

    const fourPixelPull = applyMagneticResistance(104, [100], 8, 0.45)
    expect(fourPixelPull).toBeCloseTo(102.9)
  })

  it('returns smoothly to normal movement at the edge of the radius', () => {
    expect(applyMagneticResistance(108, [100], 8, 0.45)).toBe(108)
    expect(applyMagneticResistance(84, [100], 8, 0.45)).toBe(84)
  })
})
