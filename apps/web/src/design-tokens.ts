export type TokenKind = 'color' | 'number' | 'shadow' | 'font'

export type DesignToken = {
  name: string
  label: string
  group: string
  kind: TokenKind
  value: string
  unit?: string
  min?: number
  max?: number
  step?: number
  description?: string
  scale?: string[]
}

export const DESIGN_TOKEN_STORAGE_KEY = 'thinking-pal:design-tokens:v1'
export const DESIGN_TOKEN_CHANNEL = 'thinking-pal:design-tokens'

export const designTokens: DesignToken[] = [
  { name: '--bg', label: 'Workspace', group: 'Color · surfaces', kind: 'color', value: '#ededeb' },
  { name: '--paper', label: 'Paper', group: 'Color · surfaces', kind: 'color', value: '#ffffff' },
  { name: '--surface-subtle', label: 'Subtle surface', group: 'Color · surfaces', kind: 'color', value: '#f6f6f4' },
  { name: '--surface-hover', label: 'Hover wash', group: 'Color · surfaces', kind: 'color', value: '#00000008' },
  { name: '--surface-selected', label: 'Selected wash', group: 'Color · surfaces', kind: 'color', value: '#00000012' },
  { name: '--ink', label: 'Primary ink', group: 'Color · text', kind: 'color', value: '#1d1d1f' },
  { name: '--ink-secondary', label: 'Secondary ink', group: 'Color · text', kind: 'color', value: '#3a3a3c' },
  { name: '--muted', label: 'Muted', group: 'Color · text', kind: 'color', value: '#9a9aa0' },
  { name: '--pending', label: 'AI pending', group: 'Color · text', kind: 'color', value: '#b8b8be' },
  { name: '--line', label: 'Divider', group: 'Color · borders', kind: 'color', value: '#e6e6e3' },
  { name: '--accent', label: 'Highlight text', group: 'Color · text highlight', kind: 'color', value: '#ff7a45' },
  { name: '--accent-soft', label: 'Highlight background', group: 'Color · text highlight', kind: 'color', value: '#ffe7dc' },
  { name: '--ok', label: 'Keep / success', group: 'Color · intent', kind: 'color', value: '#19b36b' },
  { name: '--no', label: 'Reject / danger', group: 'Color · intent', kind: 'color', value: '#d05a5a' },
  { name: '--focus', label: 'Focus', group: 'Color · intent', kind: 'color', value: '#0b84ff' },
  { name: '--font-sans', label: 'Interface family', group: 'Typography', kind: 'font', value: "ui-sans-serif, -apple-system, system-ui, 'Segoe UI', 'PingFang SC', sans-serif" },
  { name: '--font-size-xs', label: 'Extra small', group: 'Typography', kind: 'number', value: '11', unit: 'px', min: 9, max: 16, step: 0.5 },
  { name: '--font-size-sm', label: 'Small', group: 'Typography', kind: 'number', value: '12', unit: 'px', min: 9, max: 18, step: 0.5 },
  { name: '--font-size-ui', label: 'Interface', group: 'Typography', kind: 'number', value: '13.5', unit: 'px', min: 10, max: 20, step: 0.5 },
  { name: '--font-size-body', label: 'Body', group: 'Typography', kind: 'number', value: '14', unit: 'px', min: 11, max: 22, step: 0.5 },
  { name: '--line-height-body', label: 'Body line height', group: 'Typography', kind: 'number', value: '1.5', min: 1, max: 2, step: 0.05 },
  { name: '--space-1', label: '1', group: 'Spacing', kind: 'number', value: '4', unit: 'px', min: 0, max: 16, step: 1 },
  { name: '--space-2', label: '2', group: 'Spacing', kind: 'number', value: '8', unit: 'px', min: 0, max: 24, step: 1 },
  { name: '--space-3', label: '3', group: 'Spacing', kind: 'number', value: '12', unit: 'px', min: 0, max: 32, step: 1 },
  { name: '--space-4', label: '4', group: 'Spacing', kind: 'number', value: '16', unit: 'px', min: 0, max: 40, step: 1 },
  { name: '--space-5', label: '5', group: 'Spacing', kind: 'number', value: '20', unit: 'px', min: 0, max: 48, step: 1 },
  { name: '--radius-sm', label: 'Small', group: 'Radius', kind: 'number', value: '6', unit: 'px', min: 0, max: 24, step: 1 },
  { name: '--radius-md', label: 'Control', group: 'Radius', kind: 'number', value: '8', unit: 'px', min: 0, max: 32, step: 1 },
  { name: '--radius-lg', label: 'Modal', group: 'Radius', kind: 'number', value: '12', unit: 'px', min: 0, max: 40, step: 1 },
  { name: '--radius-panel', label: 'Panel', group: 'Radius', kind: 'number', value: '16', unit: 'px', min: 0, max: 48, step: 1 },
  { name: '--shadow', label: 'Card', group: 'Elevation', kind: 'shadow', value: '0 1px 3px #0000001a, 0 8px 24px #0000000f', scale: ['none', '0 1px 2px #00000012', '0 1px 3px #0000001a, 0 8px 24px #0000000f', '0 2px 5px #00000020, 0 12px 30px #00000016', '0 4px 10px #00000026, 0 18px 42px #0000001c', '0 8px 18px #0000002b, 0 26px 60px #00000022'] },
  { name: '--shadow-panel', label: 'Panel', group: 'Elevation', kind: 'shadow', value: '-1px 1px 4px #0000000d, -8px 0 22px #0000000b', scale: ['none', '-1px 0 2px #00000008', '-1px 1px 4px #0000000d, -8px 0 22px #0000000b', '-2px 1px 6px #00000012, -12px 0 30px #00000010', '-3px 2px 9px #00000018, -18px 0 40px #00000016', '-4px 3px 14px #00000020, -24px 0 54px #00000020'] },
  { name: '--shadow-modal', label: 'Modal', group: 'Elevation', kind: 'shadow', value: '0 12px 40px #0000002e', scale: ['none', '0 4px 14px #00000018', '0 8px 28px #00000024', '0 12px 40px #0000002e', '0 18px 54px #00000038', '0 26px 72px #00000042'] },
  { name: '--sidebar-width', label: 'Sidebar width', group: 'Layout', kind: 'number', value: '212', unit: 'px', min: 160, max: 320, step: 1 },
  { name: '--panel-handle', label: 'Panel handle', group: 'Layout', kind: 'number', value: '44', unit: 'px', min: 32, max: 64, step: 1 },
  { name: '--workspace-inset', label: 'Canvas edge inset', group: 'Layout', kind: 'number', value: '8', unit: 'px', min: 0, max: 32, step: 1 },
  { name: '--motion-fast', label: 'Fast', group: 'Motion', kind: 'number', value: '180', unit: 'ms', min: 0, max: 600, step: 10 },
  { name: '--button-height', label: 'Button height', group: 'Components · buttons', kind: 'number', value: '34', unit: 'px', min: 28, max: 48, step: 1 },
  { name: '--button-radius', label: 'Button radius', group: 'Components · buttons', kind: 'number', value: '8', unit: 'px', min: 0, max: 24, step: 1 },
  { name: '--button-primary-bg', label: 'Primary background', group: 'Components · buttons', kind: 'color', value: '#1d1d1f' },
  { name: '--button-primary-text', label: 'Primary text', group: 'Components · buttons', kind: 'color', value: '#ffffff' },
  { name: '--button-secondary-bg', label: 'Secondary background', group: 'Components · buttons', kind: 'color', value: '#ffffff' },
  { name: '--button-secondary-text', label: 'Secondary text', group: 'Components · buttons', kind: 'color', value: '#1d1d1f' },
  { name: '--button-secondary-border', label: 'Secondary border', group: 'Components · buttons', kind: 'color', value: '#d8d8d5' },
  { name: '--button-tertiary-text', label: 'Tertiary text', group: 'Components · buttons', kind: 'color', value: '#3a3a3c' },
  { name: '--button-negative-bg', label: 'Negative background', group: 'Components · buttons', kind: 'color', value: '#fdf0ee' },
  { name: '--button-negative-text', label: 'Negative text', group: 'Components · buttons', kind: 'color', value: '#b83d32' },
  { name: '--button-negative-border', label: 'Negative border', group: 'Components · buttons', kind: 'color', value: '#e8b4ac' },
]

export type TokenValues = Record<string, string>

export const defaultTokenValues = (): TokenValues => Object.fromEntries(designTokens.map((token) => [token.name, token.value]))

export function readTokenValues(): TokenValues {
  try {
    const saved = JSON.parse(localStorage.getItem(DESIGN_TOKEN_STORAGE_KEY) || '{}') as TokenValues
    if (saved['--shadow-panel'] === '-2px 1px 6px #00000012, -14px 0 34px #00000016') delete saved['--shadow-panel']
    return { ...defaultTokenValues(), ...saved }
  }
  catch { return defaultTokenValues() }
}

export function cssTokenValue(token: DesignToken, value: string) {
  return token.kind === 'number' && token.unit ? `${value}${token.unit}` : value
}

export function applyTokenValues(values: TokenValues) {
  for (const token of designTokens) document.documentElement.style.setProperty(token.name, cssTokenValue(token, values[token.name] ?? token.value))
}

export function initializeDesignTokens() {
  applyTokenValues(readTokenValues())
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(DESIGN_TOKEN_CHANNEL)
  if (channel) channel.onmessage = (event) => applyTokenValues({ ...defaultTokenValues(), ...event.data })
  window.addEventListener('storage', (event) => {
    if (event.key === DESIGN_TOKEN_STORAGE_KEY) applyTokenValues(readTokenValues())
  })
  return channel
}
