import { describe, expect, it } from 'vitest'
import { applyMagneticResistance, MAGNET_RADIUS_PX } from './image-magnet'

describe('applyMagneticResistance', () => {
  it('always moves immediately while adding resistance near an alignment', () => {
    const onePixelBefore = applyMagneticResistance(99, [100], MAGNET_RADIUS_PX)
    const onePixelPull = applyMagneticResistance(101, [100], MAGNET_RADIUS_PX)
    expect(onePixelBefore).toBeLessThan(100)
    expect(onePixelPull).toBeGreaterThan(100)
    expect(onePixelPull).toBeLessThan(101)

    const eightPixelPull = applyMagneticResistance(108, [100], MAGNET_RADIUS_PX)
    expect(eightPixelPull).toBeCloseTo(105)
  })

  it('returns smoothly to normal movement at the edge of the radius', () => {
    expect(applyMagneticResistance(116, [100], MAGNET_RADIUS_PX)).toBe(116)
    expect(applyMagneticResistance(84, [100], MAGNET_RADIUS_PX)).toBe(84)
  })
})
