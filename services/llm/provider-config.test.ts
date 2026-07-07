import { describe, it, expect, vi, afterEach } from 'vitest'
import { setProviderConfig } from './provider-config'

type SecureKeys = { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> }

function installSecureKeys(): SecureKeys {
  const sk: SecureKeys = { get: vi.fn(), set: vi.fn().mockResolvedValue(true), list: vi.fn() }
  ;(globalThis as unknown as { secureKeys?: SecureKeys }).secureKeys = sk
  return sk
}

afterEach(() => {
  delete (globalThis as unknown as { secureKeys?: SecureKeys }).secureKeys
})

describe('provider-config secure key mirror (desktop)', () => {
  it('mirrors a saved apiKey into the OS keychain when window.secureKeys exists', () => {
    const sk = installSecureKeys()
    setProviderConfig('groq', { apiKey: 'sk-desktop' })
    expect(sk.set).toHaveBeenCalledWith('llm.groq', 'sk-desktop')
  })

  it('does not touch the keychain when no apiKey is provided', () => {
    const sk = installSecureKeys()
    setProviderConfig('groq', { model: 'llama-3.3-70b' })
    expect(sk.set).not.toHaveBeenCalled()
  })

  it('is a no-op on the web (no secureKeys global)', () => {
    // No secureKeys installed → must not throw.
    expect(() => setProviderConfig('groq', { apiKey: 'sk-web' })).not.toThrow()
  })
})
