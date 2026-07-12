import { describe, expect, it } from 'vitest'
import { fetchUrlMeta, isPublicIp, parseUrlMeta, validatePublicUrl } from './url-meta'

describe('URL metadata security', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1'
  ])('rejects non-public address %s', (address) => {
    expect(isPublicIp(address)).toBe(false)
  })

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])(
    'accepts public address %s',
    (address) => {
      expect(isPublicIp(address)).toBe(true)
    }
  )

  it('rejects private DNS answers and unsafe URL forms', async () => {
    await expect(validatePublicUrl('http://example.com', async () => [
      { address: '10.0.0.2', family: 4 }
    ])).rejects.toThrow('non-public')
    await expect(validatePublicUrl('http://localhost/path')).rejects.toThrow('Private')
    await expect(validatePublicUrl('http://[::1]/path')).rejects.toThrow('Private')
    await expect(validatePublicUrl('file:///etc/passwd')).rejects.toThrow('HTTP')
    await expect(validatePublicUrl('https://user:secret@example.com')).rejects.toThrow('credentials')
    await expect(validatePublicUrl('https://example.com:8443')).rejects.toThrow('ports')
  })

  it('accepts a public DNS answer', async () => {
    const url = await validatePublicUrl('https://example.com/page', async () => [
      { address: '93.184.216.34', family: 4 }
    ])
    expect(url.href).toBe('https://example.com/page')
  })

  it('does not fetch loopback metadata targets', async () => {
    await expect(fetchUrlMeta('http://127.0.0.1/private')).resolves.toEqual({})
  })

  it('extracts bounded metadata and resolves relative images', () => {
    const result = parseUrlMeta(
      '<meta property="og:description" content="A &amp; B">' +
        '<meta property="og:image" content="/cover.png">',
      'https://example.com/page'
    )
    expect(result).toEqual({
      description: 'A & B',
      image: 'https://example.com/cover.png'
    })
  })
})
