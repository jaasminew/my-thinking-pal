export const DEFAULT_DROPPED_IMAGE_WIDTH = 320

/**
 * Converts the pointer's world-space drop point into the image's top-left
 * coordinates. The pointer is the visual center of the newly dropped image.
 */
export function placeDroppedImage(
  dropX: number,
  dropY: number,
  naturalWidth: number,
  naturalHeight: number,
  displayWidth = DEFAULT_DROPPED_IMAGE_WIDTH
) {
  const ratio = naturalWidth > 0 && naturalHeight > 0 ? naturalHeight / naturalWidth : 1
  const displayHeight = displayWidth * ratio
  return {
    x: dropX - displayWidth / 2,
    y: dropY - displayHeight / 2,
    w: displayWidth
  }
}

export function loadImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => resolve({ width: 1, height: 1 })
    image.src = src
  })
}
