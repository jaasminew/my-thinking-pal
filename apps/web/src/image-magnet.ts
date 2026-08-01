export const MAGNET_RADIUS_PX = 8
export const MAGNET_RESISTANCE = 0.45

/**
 * A continuous magnetic curve: movement begins immediately, but is damped near
 * an alignment. At the edge of the radius it rejoins normal pointer movement
 * without a jump. `resistance` is the movement ratio right at the target.
 */
export function applyMagneticResistance(
  proposed: number,
  candidates: number[],
  radius: number,
  resistance = MAGNET_RESISTANCE
): number {
  let nearest: number | null = null
  let distance = Infinity
  for (const candidate of candidates) {
    const nextDistance = Math.abs(proposed - candidate)
    if (nextDistance < distance) {
      nearest = candidate
      distance = nextDistance
    }
  }
  if (nearest === null || distance >= radius || radius <= 0) return proposed
  const direction = Math.sign(proposed - nearest)
  const dampedDistance =
    resistance * distance +
    (1 - resistance) * distance * distance / radius
  return nearest + direction * dampedDistance
}
