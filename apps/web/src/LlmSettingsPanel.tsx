import { useMemo, useState } from 'react'
import { checkLocalRuntime, setupLocalRuntime } from '../../../services/llm/local-runtime'
import type { ModelCategory } from '../../../packages/core/llm/observer-types'
import { useLocale } from './locale'

/**
 * Users make exactly two model choices (contract §5): Listener (speech-side,
 * fast — signal extraction, organize, observer evaluator, Project Memory
 * Stage-A) and Thinker (content-side, quality — co-creation, commands, observer
 * contributor). CLI runtimes are offered for Thinker only.
 */
export type ModelSelections = Record<ModelCategory, string>

export type ModelRuntime = 'api' | 'ollama' | 'codex' | 'claude-code' | 'cursor'

export type AiModelConfig = {
  id: string
  label: string
  runtime: ModelRuntime
  providerId?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  command?: string
}

type DraftConfig = Omit<AiModelConfig, 'id'>
type ModelOption = { value: string; label: string }

const CATEGORY_LABELS: Record<ModelCategory, string> = {
  listener: 'Listener (speech, fast)',
  thinker: 'Thinker (content, quality)'
}

const CLI_RUNTIMES: ModelRuntime[] = ['codex', 'claude-code', 'cursor']
const isCliConfig = (cfg: Pick<AiModelConfig, 'runtime'>) => CLI_RUNTIMES.includes(cfg.runtime)

const API_PROVIDERS = [
  { id: 'groq', label: 'Groq', baseUrl: '' },
  { id: 'openai', label: 'OpenAI', baseUrl: '' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  { id: 'cerebras', label: 'Cerebras', baseUrl: '' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: '' }
] as const

const MODEL_OPTIONS: Record<string, ModelOption[]> = {
  groq: [
    { value: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
    { value: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
    { value: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
    { value: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' }
  ],
  openai: [
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
    { value: 'gpt-5.4-nano', label: 'GPT-5.4 nano' }
  ],
  deepseek: [
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }
  ],
  cerebras: [
    { value: 'llama3.1-8b', label: 'Llama 3.1 8B' },
    { value: 'qwen-3-32b', label: 'Qwen3 32B' }
  ],
  openrouter: [
    { value: 'openai/gpt-5.5', label: 'OpenAI GPT-5.5' },
    { value: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
    { value: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { value: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' }
  ],
  ollama: [
    { value: '', label: 'Default' },
    { value: 'gpt-oss:20b', label: 'GPT-OSS 20B' },
    { value: 'gpt-oss:120b', label: 'GPT-OSS 120B' },
    { value: 'qwen3:32b', label: 'Qwen3 32B' },
    { value: 'qwen3:8b', label: 'Qwen3 8B' },
    { value: 'llama3.3:70b', label: 'Llama 3.3 70B' }
  ],
  codex: [
    { value: '', label: 'Default' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
    { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' }
  ],
  'claude-code': [
    { value: '', label: 'Default' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
    { value: 'haiku', label: 'Haiku' },
    { value: 'fable', label: 'Fable' },
    { value: 'sonnet[1m]', label: 'Sonnet 1M' },
    { value: 'opus[1m]', label: 'Opus 1M' },
    { value: 'opusplan', label: 'Opus plan' }
  ],
  cursor: [
    { value: '', label: 'Default' },
    { value: 'auto', label: 'Auto' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' }
  ]
}

const newConfigId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `model-${Date.now()}-${Math.random().toString(36).slice(2)}`

const defaultDraft = (): DraftConfig => ({
  label: '',
  runtime: 'api',
  providerId: 'groq',
  model: MODEL_OPTIONS.groq[0].value,
  apiKey: '',
  baseUrl: '',
  command: ''
})

function runtimeLabel(runtime: ModelRuntime): string {
  switch (runtime) {
    case 'api':
      return 'API model'
    case 'ollama':
      return 'Ollama local'
    case 'codex':
      return 'Codex local'
    case 'claude-code':
      return 'Claude Code local'
    case 'cursor':
      return 'Cursor local'
  }
}

function providerLabel(providerId?: string): string {
  return API_PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId ?? 'Custom API'
}

function modelOptionsFor(cfg: Pick<AiModelConfig, 'runtime' | 'providerId'>): ModelOption[] {
  if (cfg.runtime === 'api') return MODEL_OPTIONS[cfg.providerId || 'groq'] ?? MODEL_OPTIONS.groq
  return MODEL_OPTIONS[cfg.runtime] ?? [{ value: '', label: 'Default' }]
}

function modelLabel(cfg: Pick<AiModelConfig, 'runtime' | 'providerId' | 'model'>): string {
  const value = cfg.model || ''
  return modelOptionsFor(cfg).find((m) => m.value === value)?.label ?? (value || 'Default')
}

function defaultModelFor(runtime: ModelRuntime, providerId?: string): string {
  const key = runtime === 'api' ? providerId || 'groq' : runtime
  return MODEL_OPTIONS[key]?.[0]?.value ?? ''
}

function displayLabel(cfg: AiModelConfig): string {
  if (cfg.label.trim()) return cfg.label.trim()
  if (cfg.runtime === 'api') return `${providerLabel(cfg.providerId)} · ${modelLabel(cfg)}`
  if (cfg.runtime === 'ollama') return `Ollama · ${modelLabel(cfg)}`
  return `${runtimeLabel(cfg.runtime).replace(' local', '')} · ${modelLabel(cfg)}`
}

export function LlmSettingsPanel({
  configs,
  selections,
  onSave,
  onClose,
  hostedAvailable = false
}: {
  configs: readonly AiModelConfig[]
  selections: ModelSelections
  onSave: (nextSelections: ModelSelections, nextConfigs: AiModelConfig[]) => void
  onClose: () => void
  /** Signed into Go backend — empty selection uses hosted DeepSeek Flash/Pro. */
  hostedAvailable?: boolean
}) {
  const { tr } = useLocale()
  const [draftSelections, setDraftSelections] = useState<ModelSelections>(selections)
  const [draftConfigs, setDraftConfigs] = useState<AiModelConfig[]>([...configs])
  const [editingRole, setEditingRole] = useState<ModelCategory | null>(null)
  const [draftConfig, setDraftConfig] = useState<DraftConfig>(() => defaultDraft())
  const [setupError, setSetupError] = useState('')
  const [setupInfo, setSetupInfo] = useState('')
  const [checkingRuntime, setCheckingRuntime] = useState(false)
  const [settingUpRuntime, setSettingUpRuntime] = useState(false)
  const [localRuntimeReady, setLocalRuntimeReady] = useState(false)
  const [localSetupStarted, setLocalSetupStarted] = useState(false)

  const configIds = useMemo(() => new Set(draftConfigs.map((c) => c.id)), [draftConfigs])

  const patchSelection = (key: ModelCategory, value: string) =>
    setDraftSelections((d) => ({ ...d, [key]: value }))

  const patchConfig = <K extends keyof DraftConfig>(key: K, value: DraftConfig[K]) =>
    setDraftConfig((d) => ({ ...d, [key]: value }))

  const beginNew = (category: ModelCategory) => {
    setEditingRole(category)
    setDraftConfig(defaultDraft())
    setSetupError('')
    setSetupInfo('')
    setLocalRuntimeReady(false)
    setLocalSetupStarted(false)
  }

  const checkRuntimeSetup = async (cfg: AiModelConfig) => {
    if (cfg.runtime !== 'codex' && cfg.runtime !== 'claude-code' && cfg.runtime !== 'cursor') return true
    setCheckingRuntime(true)
    setSetupError('')
    try {
      const status = await checkLocalRuntime({
        runtime: cfg.runtime,
        command: cfg.command,
        model: cfg.model
      })
      if (!status.ok) {
        setSetupError(status.error || 'Local runtime is not ready.')
        setLocalRuntimeReady(false)
        return false
      }
      setSetupInfo(`${runtimeLabel(cfg.runtime)} is ready.`)
      setLocalRuntimeReady(true)
      return true
    } catch (e: any) {
      setSetupError(
        e?.message ||
          'Local runtime bridge is unavailable. Use the desktop app or run npm run dev so Thinking Pal can reach local Codex/Claude/Cursor.'
      )
      setLocalRuntimeReady(false)
      return false
    } finally {
      setCheckingRuntime(false)
    }
  }

  const startRuntimeSetup = async () => {
    if (draftConfig.runtime !== 'codex' && draftConfig.runtime !== 'claude-code' && draftConfig.runtime !== 'cursor') return
    setSettingUpRuntime(true)
    setSetupError('')
    setSetupInfo('')
    try {
      const result = await setupLocalRuntime({
        runtime: draftConfig.runtime,
        command: draftConfig.command?.trim()
      })
      if (!result.ok) {
        setSetupError(result.error || 'Setup could not be started.')
        setLocalSetupStarted(false)
        return
      }
      setSetupInfo(result.message || 'Setup started. Finish authorization, then click "Check again".')
      setLocalSetupStarted(true)
    } catch (e: any) {
      setSetupError(e?.message || 'Setup could not be started.')
      setLocalSetupStarted(false)
    } finally {
      setSettingUpRuntime(false)
    }
  }

  const draftToConfig = (id: string): AiModelConfig => {
    const providerId =
      draftConfig.runtime === 'api' && draftConfig.providerId === 'custom'
        ? `custom-${id}`
        : draftConfig.runtime === 'ollama'
          ? 'ollama'
          : draftConfig.providerId
    const baseUrl =
      draftConfig.runtime === 'ollama'
        ? draftConfig.baseUrl?.trim() || 'http://localhost:11434/v1'
        : draftConfig.baseUrl?.trim()
    return {
      id,
      label: displayLabel({ ...draftConfig, id, providerId, baseUrl, label: '' }),
      runtime: draftConfig.runtime,
      providerId,
      model: draftConfig.model?.trim(),
      apiKey: draftConfig.apiKey?.trim(),
      baseUrl,
      command: draftConfig.command?.trim()
    }
  }

  const saveNewConfig = async () => {
    if (!editingRole) return
    setSetupError('')
    const id = newConfigId()
    const next = draftToConfig(id)
    if (next.runtime === 'api' && !next.apiKey) {
      setSetupError('API key is required for an API model.')
      return
    }
    if (next.runtime === 'codex' || next.runtime === 'claude-code' || next.runtime === 'cursor') {
      const ready = await checkRuntimeSetup(next)
      if (!ready) return
    }
    setDraftConfigs((cs) => [...cs, next])
    setDraftSelections((s) => ({ ...s, [editingRole]: id }))
    setEditingRole(null)
    setDraftConfig(defaultDraft())
    setSetupError('')
    setSetupInfo('')
    setLocalRuntimeReady(false)
    setLocalSetupStarted(false)
  }

  const removeConfig = (id: string) => {
    setDraftConfigs((cs) => cs.filter((c) => c.id !== id))
    setDraftSelections((s) => ({
      listener: s.listener === id ? '' : s.listener,
      thinker: s.thinker === id ? '' : s.thinker
    }))
  }

  const save = () => {
    const byId = new Map(draftConfigs.map((c) => [c.id, c]))
    const firstWeb = draftConfigs.find((c) => !isCliConfig(c))?.id ?? ''
    const firstAny = draftConfigs[0]?.id ?? ''
    // Listener must resolve to a web config (CLI runtimes are never offered
    // there); Thinker accepts anything. Empty selection is intentional
    // (hosted DeepSeek when signed in, or "no model" locally).
    const listenerOk = (id: string) => byId.has(id) && !isCliConfig(byId.get(id)!)
    const nextSelections: ModelSelections = {
      listener: !draftSelections.listener
        ? ''
        : listenerOk(draftSelections.listener)
          ? draftSelections.listener
          : firstWeb,
      thinker: !draftSelections.thinker
        ? ''
        : byId.has(draftSelections.thinker)
          ? draftSelections.thinker
          : firstAny
    }
    onSave(nextSelections, draftConfigs)
    onClose()
  }

  const runtime = draftConfig.runtime
  const providerId = draftConfig.providerId || 'groq'
  const modelOptions = modelOptionsFor(draftConfig)
  const localRuntime = runtime === 'codex' || runtime === 'claude-code' || runtime === 'cursor'
  const primaryBusy = checkingRuntime || settingUpRuntime
  const primaryLabel = localRuntime
    ? localRuntimeReady
      ? 'Add'
      : localSetupStarted
        ? checkingRuntime
          ? 'Checking...'
          : 'Check again'
        : settingUpRuntime
          ? 'Starting...'
          : `Set up ${runtimeLabel(runtime).replace(' local', '')}`
    : 'Add'
  const primaryAction = () => {
    if (!localRuntime || localRuntimeReady) {
      void saveNewConfig()
    } else if (localSetupStarted) {
      void checkRuntimeSetup(draftToConfig('draft'))
    } else {
      void startRuntimeSetup()
    }
  }

  return (
    <div className="llm-settings-overlay" onPointerDown={onClose}>
      <div className="llm-settings" onPointerDown={(e) => e.stopPropagation()}>
        {!editingRole ? (
          <>
            <div className="llm-settings-head">
              <strong>{tr('Settings', '设置')}</strong>
              <button className="llm-settings-x" onClick={onClose} title={tr('Close', '关闭')}>
                ×
              </button>
            </div>

            <section className="llm-section">
              <h2>{tr('Model Selection', '模型选择')}</h2>
              {hostedAvailable && (
                <p className="llm-setup-info">
                  {tr(
                    'Signed in: empty selection uses hosted DeepSeek (Listener = Flash, Thinker = Pro). Add a model with your own API key to override.',
                    '已登录：未选择模型时使用托管 DeepSeek（聆听者 = Flash，思考者 = Pro）。添加带自己 API 密钥的模型可覆盖。'
                  )}
                </p>
              )}

              {(['listener', 'thinker'] as ModelCategory[]).map((category) => {
                // CLI runtimes can't back the Listener (ambient evaluator can't
                // afford CLI startup) — hide them from that dropdown only.
                const options = category === 'listener' ? draftConfigs.filter((m) => !isCliConfig(m)) : draftConfigs
                const hostedLabel =
                  category === 'listener'
                    ? tr('Hosted DeepSeek Flash', '托管 DeepSeek Flash')
                    : tr('Hosted DeepSeek Pro', '托管 DeepSeek Pro')
                const emptyLabel = hostedAvailable
                  ? hostedLabel
                  : tr('No model configured', '尚未配置模型')
                return (
                  <div className="llm-model-row" key={category}>
                    <label className="llm-field">
                      <span>{category === 'listener' ? tr('Listener (speech, fast)', '聆听者（语音，快速）') : tr('Thinker (content, quality)', '思考者（内容，高质量）')}</span>
                      <select value={draftSelections[category]} onChange={(e) => patchSelection(category, e.target.value)}>
                        {(options.length === 0 || !draftSelections[category]) && (
                          <option value="">{emptyLabel}</option>
                        )}
                        {options.map((m) => (
                          <option key={m.id} value={m.id}>{displayLabel(m)}</option>
                        ))}
                      </select>
                    </label>
                    <button className="llm-add-model" onClick={() => beginNew(category)}>
                      {tr('+ New Model', '+ 新建模型')}
                    </button>
                  </div>
                )
              })}
            </section>

            {draftConfigs.length > 0 && (
              <section className="llm-section">
                <h2>{tr('Saved models', '已保存的模型')}</h2>
                <ul className="llm-saved-list">
                  {draftConfigs.map((m) => (
                    <li className="llm-saved-row" key={m.id}>
                      <span className="llm-saved-label" title={displayLabel(m)}>
                        {displayLabel(m)}
                      </span>
                      <button
                        type="button"
                        className="llm-delete-model"
                        onClick={() => removeConfig(m.id)}
                      >
                        {tr('Delete', '删除')}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="llm-settings-actions">
              <button className="llm-save" onClick={save}>
                {tr('Save', '保存')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="llm-settings-head llm-settings-head-new">
              <button className="llm-back" onClick={() => setEditingRole(null)}>
                {tr('Back', '返回')}
              </button>
              <strong>{tr('New Model', '新建模型')}</strong>
              <button className="llm-settings-x" onClick={onClose} title={tr('Close', '关闭')}>
                ×
              </button>
            </div>

            <section className="llm-section">

            <label className="llm-field">
              <span>{tr('Type', '类型')}</span>
              <select
                value={runtime}
                onChange={(e) => {
                  const next = e.target.value as ModelRuntime
                  setDraftConfig((d) => ({
                    ...d,
                    runtime: next,
                    providerId: next === 'ollama' ? 'ollama' : next === 'api' ? 'groq' : undefined,
                    baseUrl: next === 'ollama' ? 'http://localhost:11434/v1' : '',
                    model: defaultModelFor(next, next === 'api' ? 'groq' : undefined),
                    command: next === 'codex' ? 'codex' : next === 'claude-code' ? 'claude' : next === 'cursor' ? 'cursor' : ''
                  }))
                  setSetupError('')
                  setSetupInfo('')
                  setLocalRuntimeReady(false)
                  setLocalSetupStarted(false)
                }}
              >
                <option value="api">{tr('API model', 'API 模型')}</option>
                <option value="ollama">{tr('Ollama local', '本地 Ollama')}</option>
                <option value="codex">{tr('Codex local', '本地 Codex')}</option>
                <option value="claude-code">{tr('Claude Code local', '本地 Claude Code')}</option>
                <option value="cursor">{tr('Cursor local', '本地 Cursor')}</option>
              </select>
            </label>

            {runtime === 'api' && (
              <>
                <label className="llm-field">
                  <span>{tr('Provider', '提供商')}</span>
                  <select
                    value={providerId}
                    onChange={(e) => {
                      const provider = API_PROVIDERS.find((p) => p.id === e.target.value)
                      setDraftConfig((d) => ({
                        ...d,
                        providerId: e.target.value,
                        baseUrl: provider?.baseUrl ?? d.baseUrl,
                        model: defaultModelFor('api', e.target.value)
                      }))
                    }}
                  >
                    {API_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </label>

                <label className="llm-field">
                  <span>{tr('Model', '模型')}</span>
                  <select value={draftConfig.model || ''} onChange={(e) => patchConfig('model', e.target.value)}>
                    {modelOptions.map((m) => (
                      <option key={m.value || 'default'} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </label>

                <label className="llm-field">
                  <span>{tr('API key', 'API 密钥')}</span>
                  <input
                    value={draftConfig.apiKey}
                    onChange={(e) => patchConfig('apiKey', e.target.value)}
                    type="password"
                    placeholder="sk-..."
                  />
                  <span className="llm-field-hint">
                    {tr(
                      'Required to override hosted models with your own provider.',
                      '用于覆盖托管模型，改用你自己的提供商。'
                    )}
                  </span>
                </label>

                {draftConfig.providerId === 'deepseek' && (
                  <label className="llm-field">
                    <span>Base URL</span>
                    <input
                      value={draftConfig.baseUrl}
                      onChange={(e) => patchConfig('baseUrl', e.target.value)}
                      placeholder="https://api.example.com/v1"
                    />
                  </label>
                )}
              </>
            )}

            {runtime === 'ollama' && (
              <>
                <label className="llm-field">
                  <span>{tr('Model', '模型')}</span>
                  <select value={draftConfig.model || ''} onChange={(e) => patchConfig('model', e.target.value)}>
                    {modelOptions.map((m) => (
                      <option key={m.value || 'default'} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </label>
                <label className="llm-field">
                  <span>{tr('Base URL', '基础 URL')}</span>
                  <input
                    value={draftConfig.baseUrl}
                    onChange={(e) => patchConfig('baseUrl', e.target.value)}
                    placeholder="http://localhost:11434/v1"
                  />
                </label>
              </>
            )}

            {(runtime === 'codex' || runtime === 'claude-code' || runtime === 'cursor') && (
              <>
                <label className="llm-field">
                  <span>{tr('Model', '模型')}</span>
                  <select value={draftConfig.model || ''} onChange={(e) => patchConfig('model', e.target.value)}>
                    {modelOptions.map((m) => (
                      <option key={m.value || 'default'} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </label>
                <label className="llm-field">
                  <span>{tr('Command', '命令')}</span>
                  <input
                    value={draftConfig.command}
                    onChange={(e) => patchConfig('command', e.target.value)}
                    placeholder={runtime === 'claude-code' ? 'claude' : runtime}
                  />
                </label>
              </>
            )}

            {setupInfo && <p className="llm-setup-info">{setupInfo}</p>}
            {setupError && <p className="auth-error llm-setup-error">{setupError}</p>}

            <div className="llm-settings-actions">
              <button className="clear-saved" onClick={() => setEditingRole(null)}>
                {tr('Cancel', '取消')}
              </button>
              <button className="llm-save" onClick={primaryAction} disabled={primaryBusy}>
                {primaryLabel}
              </button>
            </div>
          </section>
          </>
        )}
      </div>
    </div>
  )
}
