import { useState } from 'react'
import type { SelectionSnapshot } from './command-session'
import type { TextStylePatch } from './rich-text'
import { useLocale } from './locale'

type Picker = 'color' | 'size' | 'weight' | null

const ColorIcon = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M6 15 10 4l4 11M7.4 11.5h5.2" />
    <path className="accent-line" d="M4 18h12" />
  </svg>
)
const SizeIcon = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M3 15 7 5l4 10M4.4 11.5h5.2M12 7h5M14.5 4.5v5" />
  </svg>
)
const WeightIcon = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M6 4h5a3 3 0 0 1 0 6H6V4Zm0 6h5.5a3 3 0 0 1 0 6H6v-6Z" />
  </svg>
)
const ListIcon = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
    <circle cx="4" cy="10" r="1" fill="currentColor" stroke="none" />
    <circle cx="4" cy="14" r="1" fill="currentColor" stroke="none" />
    <path d="M8 6h8M8 10h8M8 14h8" />
  </svg>
)
const SparkIcon = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M10 2c.5 4.1 1.9 5.5 6 6-4.1.5-5.5 1.9-6 6-.5-4.1-1.9-5.5-6-6 4.1-.5 5.5-1.9 6-6Z" />
  </svg>
)

export function SelectionToolbar({
  snapshot,
  allBulleted,
  onFormat,
  onToggleBullets,
  onSummon
}: {
  snapshot: SelectionSnapshot
  allBulleted: boolean
  onFormat: (patch: TextStylePatch) => void
  onToggleBullets: () => void
  onSummon: () => void
}) {
  const { tr } = useLocale()
  const [picker, setPicker] = useState<Picker>(null)
  // Five 34px tools + four 2px gaps + 8px horizontal padding.
  const W = 186
  const left = Math.max(8, Math.min(snapshot.screenRect.left + snapshot.screenRect.width / 2 - W / 2, window.innerWidth - W - 8))
  const above = snapshot.screenRect.top - 52
  const top = above >= 8 ? above : snapshot.screenRect.top + snapshot.screenRect.height + 10
  const tool = (label: string, icon: React.ReactNode, click: () => void, active = false) => (
    <button
      type="button"
      className={`selection-tool tooltip-target ${active ? 'active' : ''}`}
      data-tooltip={label}
      aria-label={label}
      onClick={click}
    >
      {icon}
    </button>
  )
  return (
    <div className="selection-toolbar" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
      {tool(tr('Text color', '文字颜色'), ColorIcon, () => setPicker(picker === 'color' ? null : 'color'), picker === 'color')}
      {tool(tr('Font size', '字号'), SizeIcon, () => setPicker(picker === 'size' ? null : 'size'), picker === 'size')}
      {tool(tr('Font weight', '字重'), WeightIcon, () => setPicker(picker === 'weight' ? null : 'weight'), picker === 'weight')}
      {tool(tr('Bulleted list', '项目符号列表'), ListIcon, onToggleBullets, allBulleted)}
      {tool(tr('Summon AI', '召唤 AI'), SparkIcon, onSummon)}
      {picker === 'color' && (
        <div className="selection-picker color-picker">
          {['#1d1d1f', '#e34a33', '#e56b18', '#2f7d57', '#2667c9', '#7652a8'].map((color) => (
            <button
              key={color}
              aria-label={color}
              style={{ background: color }}
              onClick={() => { onFormat({ color }); setPicker(null) }}
            />
          ))}
        </div>
      )}
      {picker === 'size' && (
        <div className="selection-picker option-picker">
          {[13, 15, 18, 24].map((size) => (
            <button key={size} onClick={() => { onFormat({ size }); setPicker(null) }}>
              {size}
            </button>
          ))}
        </div>
      )}
      {picker === 'weight' && (
        <div className="selection-picker option-picker">
          {([400, 600, 700] as const).map((weight) => (
            <button
              key={weight}
              style={{ fontWeight: weight }}
              onClick={() => { onFormat({ weight }); setPicker(null) }}
            >
              {weight === 400 ? tr('Regular', '常规') : weight === 600 ? tr('Medium', '中等') : tr('Bold', '粗体')}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
