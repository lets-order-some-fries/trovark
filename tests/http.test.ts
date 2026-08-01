import { describe, expect, it, vi } from 'vitest'
import { createHttp } from '../src/util/http.js'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('createHttp', () => {
  it('parses JSON', async () => {
    const fetchImpl = vi.fn(async () => ok({ a: 1 }))
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await http.json('https://x.test/')).toEqual({ a: 1 })
  })
  it('retries on 500 then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(ok({ ok: true }))
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 2 })
    expect(await http.json('https://x.test/')).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('does NOT retry on 404 — throws immediately', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 2 })
    await expect(http.json('https://x.test/')).rejects.toThrow('404')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('sends GitHub token only to api.github.com', async () => {
    const fetchImpl = vi.fn(async () => ok({}))
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, githubToken: 'T' })
    await http.json('https://api.github.com/repos/a/b')
    await http.json('https://registry.npmjs.org/x')
    const auth = (i: number) => (fetchImpl.mock.calls[i][1]?.headers as Record<string, string>).authorization
    expect(auth(0)).toBe('Bearer T')
    expect(auth(1)).toBeUndefined()
  })
  it('postJson sends POST with JSON content-type and body, and parses the JSON response', async () => {
    const fetchImpl = vi.fn(async () => ok({ results: [] }))
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await http.postJson<{ results: unknown[] }>('https://x.test/batch', { queries: [{ a: 1 }] })
    expect(result).toEqual({ results: [] })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://x.test/batch')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(init.body).toBe(JSON.stringify({ queries: [{ a: 1 }] }))
  })
  it('postJson retries on 500 then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(ok({ ok: true }))
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 2 })
    expect(await http.postJson('https://x.test/batch', { a: 1 })).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('jsonWithHeaders parses JSON, returns response headers, and retries via the same request path', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { 'x-test': 'yes' } }))
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 2 })
    const { data, headers } = await http.jsonWithHeaders<{ a: number }>('https://x.test/')
    expect(data).toEqual({ a: 1 })
    expect(headers.get('x-test')).toBe('yes')
    expect(fetchImpl).toHaveBeenCalledTimes(2) // proves it went through the retry path, not a duplicate impl
  })
})
