import { useEffect, useRef, useState } from 'react'
import { useLocale } from './locale'
import type { MediaType } from './canvas-types'
import { mediaTypeForSource } from './image-drop-placement'
import {
  applyMagneticResistance,
  MAGNET_RADIUS_PX
} from './image-magnet'

const LinkIcon = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="m8 12 4-4M7 14H5a4 4 0 0 1 0-8h3M13 6h2a4 4 0 1 1 0 8h-3" />
  </svg>
)
const SparkIcon = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M10 2c.5 4.1 1.9 5.5 6 6-4.1.5-5.5 1.9-6 6-.5-4.1-1.9-5.5-6-6 4.1-.5 5.5-1.9 6-6Z" />
  </svg>
)
const PlayIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 7.5v9l7-4.5-7-4.5Z" />
  </svg>
)
const PauseIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 8v8M15 8v8" />
  </svg>
)

type ResizeHandle = 'top' | 'right' | 'bottom' | 'left' | 'tl' | 'tr' | 'bl' | 'br'

export function proportionalImageResize(
  handle: ResizeHandle,
  startWidth: number,
  startHeight: number,
  deltaX: number,
  deltaY: number,
  scale: number
) {
  const safeScale = scale > 0 ? scale : 1
  const ratio = startHeight > 0 ? startWidth / startHeight : 1
  const fromLeft = handle === 'left' || handle === 'tl' || handle === 'bl'
  const fromRight = handle === 'right' || handle === 'tr' || handle === 'br'
  const fromTop = handle === 'top' || handle === 'tl' || handle === 'tr'
  const fromBottom = handle === 'bottom' || handle === 'bl' || handle === 'br'
  const horizontalDelta = (fromLeft ? -deltaX : deltaX) / safeScale
  const verticalDelta = (fromTop ? -deltaY : deltaY) * ratio / safeScale
  let widthDelta = 0
  if (fromLeft || fromRight) widthDelta = horizontalDelta
  if (fromTop || fromBottom) {
    // Corners react to whichever axis the pointer moved most decisively along.
    // Edges use their own axis, while every path changes one width value so the
    // browser can retain the image's intrinsic aspect ratio.
    if (!(fromLeft || fromRight) || Math.abs(verticalDelta) > Math.abs(widthDelta)) {
      widthDelta = verticalDelta
    }
  }
  return anchoredImageResize(handle, startWidth, startHeight, startWidth + widthDelta)
}

export function anchoredImageResize(
  handle: ResizeHandle,
  startWidth: number,
  startHeight: number,
  proposedWidth: number
) {
  const ratio = startHeight > 0 ? startWidth / startHeight : 1
  const width = Math.max(72, Math.min(1200, proposedWidth))
  const height = width / ratio
  const widthChange = startWidth - width
  const heightChange = startHeight - height
  const shiftX = handle === 'left' || handle === 'tl' || handle === 'bl'
    ? widthChange
    : handle === 'top' || handle === 'bottom'
      ? widthChange / 2
      : 0
  const shiftY = handle === 'top' || handle === 'tl' || handle === 'tr'
    ? heightChange
    : handle === 'left' || handle === 'right'
      ? heightChange / 2
      : 0
  return { width, shiftX, shiftY }
}

export function safeImageUrl(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

export function EditableImage({
  src,
  mediaType,
  url,
  title,
  width,
  selected,
  aiPromptActive = false,
  scale,
  className = '',
  style,
  dataImageId,
  onPointerDownImage,
  onOpen,
  onMove,
  onMoveStart,
  onResize,
  onResizeStart,
  getMagneticHeights,
  onUrlChange,
  onUrlChangeStart,
  onSummon,
  onError
}: {
  src: string
  mediaType?: MediaType
  url?: string
  title?: string
  width?: number
  selected?: boolean
  /** The black image toolbar is replaced by this image's contextual AI input. */
  aiPromptActive?: boolean
  scale: number
  className?: string
  style?: React.CSSProperties
  dataImageId?: string
  onPointerDownImage?: (e: React.PointerEvent<HTMLElement>) => void
  onOpen: (rect: DOMRect) => void
  /** Pointer movement from drag start in world coordinates. */
  onMove?: (shiftX: number, shiftY: number) => void
  onMoveStart?: () => void
  /** New width plus the X/Y shift from drag start that keeps the opposite anchor fixed. */
  onResize: (width: number, shiftX: number, shiftY: number) => void
  onResizeStart?: () => void
  /** Other canvas-image heights in world coordinates, captured when resize starts. */
  getMagneticHeights?: () => number[]
  onUrlChange: (url?: string) => void
  onUrlChangeStart?: () => void
  onSummon: (rect: DOMRect) => void
  onError?: (e: React.SyntheticEvent<HTMLElement>) => void
}) {
  const { tr } = useLocale()
  const frameRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(false)
  const [selfSelected, setSelfSelected] = useState(false)
  const suppressClickRef = useRef(false)
  const [videoPaused, setVideoPaused] = useState(true)
  const resolvedMediaType = mediaTypeForSource(src, mediaType)
  const isVideo = resolvedMediaType === 'video'
  const shownSelected = selected ?? selfSelected
  useEffect(() => setVideoPaused(true), [src, isVideo])
  useEffect(() => {
    if (selected !== undefined || !selfSelected) return
    const clear = (e: PointerEvent) => {
      if (!frameRef.current?.contains(e.target as Node)) setSelfSelected(false)
    }
    document.addEventListener('pointerdown', clear)
    return () => document.removeEventListener('pointerdown', clear)
  }, [selected, selfSelected])
  useEffect(() => {
    if (linkOpen && !url) setTimeout(() => inputRef.current?.focus(), 0)
  }, [linkOpen, url])

  const save = () => {
    const next = safeImageUrl(draft)
    if (!next) { setError(true); return }
    onUrlChangeStart?.()
    onUrlChange(next)
    setDraft('')
    setError(false)
    setLinkOpen(false)
  }
  const beginResize = (handle: ResizeHandle) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const frame = frameRef.current
    if (!frame) return
    if (selected === undefined) setSelfSelected(true)
    onResizeStart?.()
    const startX = e.clientX
    const startY = e.clientY
    const rect = frame.getBoundingClientRect()
    const startW = rect.width / (scale || 1)
    const startH = rect.height / (scale || 1)
    const ratio = startH > 0 ? startW / startH : 1
    const magneticHeights = getMagneticHeights?.() ?? [...(frame.closest('.canvas-layer')?.querySelectorAll<HTMLElement>('.editable-image') ?? [])]
      .filter((element) => element !== frame)
      .map((element) => element.getBoundingClientRect().height / (scale || 1))
      .filter((height) => height > 0)
    const magneticRadius = MAGNET_RADIUS_PX / (scale || 1)
    const move = (ev: PointerEvent) => {
      const raw = proportionalImageResize(
        handle,
        startW,
        startH,
        ev.clientX - startX,
        ev.clientY - startY,
        scale
      )
      const magneticHeight = applyMagneticResistance(
        raw.width / ratio,
        magneticHeights,
        magneticRadius
      )
      const next = anchoredImageResize(handle, startW, startH, magneticHeight * ratio)
      onResize(next.width, next.shiftX, next.shiftY)
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  const beginMediaPointerDown = (e: React.PointerEvent<HTMLImageElement | HTMLVideoElement>) => {
    suppressClickRef.current = false
    const sx = e.clientX, sy = e.clientY
    const frame = frameRef.current
    const startRect = frame?.getBoundingClientRect()
    const otherRects = frame
      ? [...(frame.closest('.canvas-layer')?.querySelectorAll<HTMLElement>('.editable-image') ?? [])]
          .filter((element) => element !== frame)
          .map((element) => element.getBoundingClientRect())
      : []
    if (onMove) onMoveStart?.()
    const move = (ev: PointerEvent) => {
      const pointerDx = ev.clientX - sx
      const pointerDy = ev.clientY - sy
      if (Math.abs(pointerDx) > 4 || Math.abs(pointerDy) > 4) suppressClickRef.current = true
      if (!onMove || !startRect) return
      const magneticLeft = applyMagneticResistance(
        startRect.left + pointerDx,
        otherRects.map((rect) => rect.left),
        MAGNET_RADIUS_PX
      )
      const magneticTop = applyMagneticResistance(
        startRect.top + pointerDy,
        otherRects.map((rect) => rect.top),
        MAGNET_RADIUS_PX
      )
      const safeScale = scale || 1
      onMove(
        (magneticLeft - startRect.left) / safeScale,
        (magneticTop - startRect.top) / safeScale
      )
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    onPointerDownImage?.(e as React.PointerEvent<HTMLElement>)
  }

  const openPreview = (e: React.MouseEvent<HTMLImageElement | HTMLVideoElement>) => {
    e.stopPropagation()
    if (suppressClickRef.current) return
    if (isVideo) videoRef.current?.pause()
    onOpen(e.currentTarget.getBoundingClientRect())
  }

  const toggleVideo = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      try { await video.play() } catch { /* browser can still expose native failure state */ }
    } else {
      video.pause()
    }
  }

  return (
    <div
      ref={frameRef}
      data-imageid={dataImageId}
      className={`editable-image ${shownSelected ? 'selected' : ''} ${className}`}
      style={{ ...style, width: width ? `${width}px` : style?.width, '--canvas-scale': scale } as React.CSSProperties}
      onPointerDown={(e) => { e.stopPropagation(); if (selected === undefined) setSelfSelected(true) }}
    >
      {isVideo ? (
        <video
          ref={videoRef}
          src={src}
          aria-label={title || tr('Video', '视频')}
          draggable={false}
          playsInline
          preload="metadata"
          onPointerDown={beginMediaPointerDown}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={openPreview}
          onPlay={() => setVideoPaused(false)}
          onPause={() => setVideoPaused(true)}
          onEnded={() => setVideoPaused(true)}
          onError={onError}
        />
      ) : (
        <img
          src={src}
          alt={title || ''}
          draggable={false}
          onPointerDown={beginMediaPointerDown}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={openPreview}
          onError={onError}
        />
      )}
      {isVideo && (
        <button
          type="button"
          className={`video-play ${videoPaused ? 'paused' : 'playing'}`}
          aria-label={tr(videoPaused ? 'Play video' : 'Pause video', videoPaused ? '播放视频' : '暂停视频')}
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation() }}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={toggleVideo}
        >
          {videoPaused ? PlayIcon : PauseIcon}
        </button>
      )}
      {!aiPromptActive && <div className="image-toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <button
          className={`tooltip-target ${linkOpen ? 'active' : ''}`}
          data-tooltip={tr(url ? 'Attached URL' : 'Attach URL', url ? '已附加网址' : '附加网址')}
          aria-label={tr(url ? 'Attached URL' : 'Attach URL', url ? '已附加网址' : '附加网址')}
          onClick={() => setLinkOpen((v) => !v)}
        >
          {LinkIcon}
        </button>
        <button
          className="tooltip-target"
          data-tooltip={tr('Summon AI', '召唤 AI')}
          aria-label={tr('Summon AI', '召唤 AI')}
          onClick={() => { const rect = frameRef.current?.getBoundingClientRect(); if (rect) onSummon(rect) }}
        >
          {SparkIcon}
        </button>
        {linkOpen && (
          <div className="image-link-editor">
            {url ? (
              <>
                <span title={url}>{url}</span>
                <button onClick={() => { onUrlChangeStart?.(); onUrlChange(undefined); setLinkOpen(false) }}>{tr('Remove', '移除')}</button>
              </>
            ) : (
              <>
                <input
                  ref={inputRef}
                  value={draft}
                  className={error ? 'invalid' : ''}
                  placeholder="https://…"
                  onChange={(e) => { setDraft(e.target.value); setError(false) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') save()
                    else if (e.key === 'Escape') { setLinkOpen(false); setDraft(''); setError(false) }
                  }}
                />
                <button onClick={save}>{tr('Attach', '附加')}</button>
              </>
            )}
          </div>
        )}
      </div>}
      {(['top', 'right', 'bottom', 'left'] as const).map((edge) => (
        <i
          key={edge}
          aria-hidden="true"
          className={`image-resize-edge ${edge}`}
          onPointerDown={beginResize(edge)}
        />
      ))}
      {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
        <i
          key={corner}
          aria-hidden="true"
          className={`image-resize ${corner}`}
          onPointerDown={beginResize(corner)}
        />
      ))}
    </div>
  )
}
