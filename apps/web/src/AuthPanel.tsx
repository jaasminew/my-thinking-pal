import { useState } from 'react'
import type { Backend } from './backend'

// Compact login/register modal. Only mounted when the backend is configured.
// Signing in enables cross-device sync (board over /sync) and backend STT;
// staying signed out keeps the original local-only experience.
export function AuthPanel({ backend, onClose }: { backend: Backend; onClose: () => void }) {
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
          <strong>{backend.user ? 'Account' : mode === 'login' ? 'Sign in' : 'Create account'}</strong>
          <button className="llm-settings-x" onClick={onClose} title="Close">×</button>
        </div>

        {backend.user ? (
          <>
            <p className="llm-note">
              Signed in as <strong>{backend.user.email}</strong>. Boards sync across your devices and speech goes
              through the backend STT proxy.
            </p>
            <div className="llm-settings-actions">
              <button
                className="clear-saved"
                onClick={async () => {
                  await backend.logout()
                  onClose()
                }}
              >
                Sign out
              </button>
            </div>
          </>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <label className="llm-field">
              <span>Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            </label>
            <label className="llm-field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={8}
                placeholder="at least 8 characters"
                required
              />
            </label>
            {backend.error && <p className="auth-error">{backend.error}</p>}
            <div className="llm-settings-actions auth-actions">
              <button type="submit" className="llm-save" disabled={busy}>
                {busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
              </button>
              <button
                type="button"
                className="auth-switch"
                onClick={() => {
                  setMode((m) => (m === 'login' ? 'register' : 'login'))
                }}
              >
                {mode === 'login' ? 'Need an account?' : 'Have an account?'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
