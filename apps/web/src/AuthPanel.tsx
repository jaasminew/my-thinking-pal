import { useState } from 'react'
import type { Backend } from './backend'
import { useLocale } from './locale'

// Compact login/register modal. Only mounted when the backend is configured.
// Signing in enables cross-device sync (board over /sync) and backend STT;
// staying signed out keeps the original local-only experience.
export function AuthPanel({ backend, onClose }: { backend: Backend; onClose: () => void }) {
  const { tr } = useLocale()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      if (mode === 'login') await backend.login(email.trim(), password)
      else await backend.register(email.trim(), password)
      onClose()
    } catch {
      /* backend.error is shown below */
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="llm-settings-overlay" onPointerDown={onClose}>
      <div className="llm-settings" onPointerDown={(e) => e.stopPropagation()}>
        <div className="llm-settings-head">
          <strong>{backend.user ? tr('Account', '账户') : mode === 'login' ? tr('Sign in', '登录') : tr('Create account', '创建账户')}</strong>
          <button className="llm-settings-x" onClick={onClose} title={tr('Close', '关闭')}>×</button>
        </div>

        {backend.user ? (
          <>
            <p className="llm-note">
              {tr(`Signed in as ${backend.user.email}. Your workspace (sidebar + canvases) syncs across devices; speech goes through the backend STT proxy.`, `已登录：${backend.user.email}。Workspace（侧栏与画布内容）会在设备间同步，语音通过后端 STT 代理处理。`)}
            </p>
            <div className="llm-settings-actions">
              <button
                className="clear-saved"
                onClick={async () => {
                  await backend.logout()
                  onClose()
                }}
              >
                {tr('Sign out', '退出登录')}
              </button>
            </div>
          </>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <label className="llm-field">
              <span>{tr('Email', '邮箱')}</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            </label>
            <label className="llm-field">
              <span>{tr('Password', '密码')}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={8}
                placeholder={tr('at least 8 characters', '至少 8 个字符')}
                required
              />
            </label>
            {backend.error && <p className="auth-error">{backend.error}</p>}
            <div className="llm-settings-actions auth-actions">
              <button type="submit" className="llm-save" disabled={busy}>
                {busy ? '…' : mode === 'login' ? tr('Sign in', '登录') : tr('Create account', '创建账户')}
              </button>
              <button
                type="button"
                className="auth-switch"
                onClick={() => {
                  setMode((m) => (m === 'login' ? 'register' : 'login'))
                }}
              >
                {mode === 'login' ? tr('Need an account?', '还没有账户？') : tr('Have an account?', '已有账户？')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
