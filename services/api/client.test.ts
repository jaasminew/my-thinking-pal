import { describe, it, expect } from 'vitest'
import { ApiClient, ApiError, type FetchLike } from './client'
import { TokenStore, memoryStorage } from './tokens'
import { wsUrl } from './config'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function makeClient(fetchImpl: FetchLike) {
  const tokens = new TokenStore(memoryStorage())
  const client = new ApiClient({ baseUrl: 'http://api.test', tokens, fetchImpl })
  return { client, tokens }
}

const pair = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: { id: 'u1', email: 'a@b.com', createdAt: '2026-01-01T00:00:00Z' }
}

describe('ApiClient auth', () => {
  it('login stores tokens', async () => {
    const { client, tokens } = makeClient(async (url) => {
      expect(url).toBe('http://api.test/auth/login')
      return jsonResponse(200, pair)
    })
    const got = await client.login('a@b.com', 'password12')
    expect(got.user.email).toBe('a@b.com')
    expect(tokens.access).toBe('access-1')
    expect(client.isAuthenticated).toBe(true)
  })

  it('surfaces backend error messages', async () => {
    const { client } = makeClient(async () => jsonResponse(409, { error: 'email already registered' }))
    await expect(client.register('a@b.com', 'password12')).rejects.toMatchObject({
      status: 409,
      message: 'email already registered'
    })
  })

  it('logout clears tokens', async () => {
    const { client, tokens } = makeClient(async () => new Response(null, { status: 204 }))
    tokens.save(pair)
    await client.logout()
    expect(tokens.access).toBeNull()
    expect(tokens.refresh).toBeNull()
  })
})

describe('ApiClient token refresh', () => {
  it('refreshes and retries once on 401', async () => {
    const { client, tokens } = makeClient(async (url, init) => {
      if (url.endsWith('/documents')) {
        const auth = (init?.headers as Record<string, string>)?.Authorization
        if (auth === 'Bearer access-1') return jsonResponse(401, { error: 'expired' })
        if (auth === 'Bearer access-2') return jsonResponse(200, [{ id: 'd1' }])
        return jsonResponse(500, { error: 'unexpected auth ' + auth })
      }
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse(200, { ...pair, accessToken: 'access-2', refreshToken: 'refresh-2' })
      }
      return jsonResponse(500, { error: 'unexpected ' + url })
    })
    tokens.save(pair)
    const docs = await client.listDocuments()
    expect(docs).toEqual([{ id: 'd1' }])
    expect(tokens.access).toBe('access-2')
  })

  it('clears tokens and throws when refresh fails', async () => {
    const { client, tokens } = makeClient(async (url) => {
      if (url.endsWith('/auth/refresh')) return jsonResponse(401, { error: 'nope' })
      return jsonResponse(401, { error: 'expired' })
    })
    tokens.save(pair)
    await expect(client.listDocuments()).rejects.toBeInstanceOf(ApiError)
    expect(tokens.access).toBeNull()
  })
})

describe('ApiClient documents', () => {
  it('creates a document', async () => {
    const { client, tokens } = makeClient(async (url, init) => {
      expect(url).toBe('http://api.test/documents')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ title: 'My Board' })
      return jsonResponse(201, { id: 'd9', ownerId: 'u1', title: 'My Board', createdAt: '', updatedAt: '' })
    })
    tokens.save(pair)
    const doc = await client.createDocument('My Board')
    expect(doc.id).toBe('d9')
  })

  it('renames a document via PATCH', async () => {
    const { client, tokens } = makeClient(async (url, init) => {
      expect(url).toBe('http://api.test/documents/d9')
      expect(init?.method).toBe('PATCH')
      expect(JSON.parse(String(init?.body))).toEqual({ title: 'Renamed' })
      return new Response(null, { status: 204 })
    })
    tokens.save(pair)
    await expect(client.patchDocument('d9', 'Renamed')).resolves.toBeUndefined()
  })

  it('deletes a document via DELETE', async () => {
    const { client, tokens } = makeClient(async (url, init) => {
      expect(url).toBe('http://api.test/documents/d9')
      expect(init?.method).toBe('DELETE')
      return new Response(null, { status: 204 })
    })
    tokens.save(pair)
    await expect(client.deleteDocument('d9')).resolves.toBeUndefined()
  })
})

describe('wsUrl', () => {
  it('converts http->ws and appends token', () => {
    expect(wsUrl('https://api.test', '/sync/d1', 'tok en')).toBe('wss://api.test/sync/d1?token=tok%20en')
    expect(wsUrl('http://api.test', '/stt', 't')).toBe('ws://api.test/stt?token=t')
  })
})
