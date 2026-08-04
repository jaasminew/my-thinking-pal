import type { MediaType } from './canvas-types'

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

export function mediaTypeForFile(file: Pick<File, 'type' | 'name'>): MediaType | null {
  const mime = file.type.toLowerCase()
  const name = file.name.toLowerCase()
  if (mime === 'image/gif' || name.endsWith('.gif')) return 'gif'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv|ogg)$/i.test(name)) return 'video'
  return null
}

export function mediaTypeForSource(src: string, explicit?: MediaType): MediaType {
  if (explicit) return explicit
  const value = src.trim().toLowerCase()
  if (value.startsWith('data:image/gif') || /\.gif(?:[?#]|$)/.test(value)) return 'gif'
  if (value.startsWith('data:video/') || /\.(mp4|m4v|mov|webm|ogv|ogg)(?:[?#]|$)/.test(value)) return 'video'
  return 'image'
}

export function loadMediaDimensions(src: string, mediaType: MediaType): Promise<{ width: number; height: number }> {
  if (mediaType !== 'video') return loadImageDimensions(src)
  return new Promise((resolve) => {
    const video = document.createElement('video')
    const done = (width: number, height: number) => {
      video.removeAttribute('src')
      video.load()
      resolve({ width, height })
    }
    video.onloadedmetadata = () => done(video.videoWidth || 1, video.videoHeight || 1)
    video.onerror = () => done(1, 1)
    video.preload = 'metadata'
    video.src = src
  })
}
