import { describe, expect, it, vi } from 'vitest'
import { createHttp, HttpError, RateLimitError } from '../src/util/http.js'

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
  // W1: a typed status lets callers (e.g. collectGithub) distinguish "repo
  // gone (404)" from other failures without parsing the message string.
  it('throws a typed HttpError carrying the numeric status on a non-retryable failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 2 })
    await expect(http.json('https://x.test/repo')).rejects.toBeInstanceOf(HttpError)
    const err = await http.json('https://x.test/repo').catch(e => e as HttpError)
    expect(err.status).toBe(404)
  })
  it('throws a typed HttpError on a retry-exhausted 5xx too', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }))
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 1 })
    const err = await http.json('https://x.test/').catch(e => e as HttpError)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(503)
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

  // A 403 with x-ratelimit-remaining: 0 is a fact about the CALLER's budget,
  // not about the repository being scanned. Typed separately so the CLI can
  // say "your rate limit is exhausted" instead of blaming the scanned ref.
  it('types an exhausted primary rate limit and does not retry it', async () => {
    const reset = String(Math.floor(Date.UTC(2026, 6, 31, 1, 0, 0) / 1000))
    const fetchImpl = vi.fn(async () => new Response('{"message":"API rate limit exceeded"}', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
    }))
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 2 })
    await expect(http.json('https://api.github.com/repos/a/b')).rejects.toBeInstanceOf(RateLimitError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const err = await http.json('https://api.github.com/repos/a/b').catch(e => e as RateLimitError)
    expect(err.resetEpoch).toBe(Number(reset))
    expect(err.status).toBe(403)
  })

  it('leaves a secondary-limit 403 as an ordinary HttpError', async () => {
    // GitHub's secondary limit carries no remaining: 0. The scanner treats
    // those as transient and retries them; they must not become RateLimitError.
    const fetchImpl = vi.fn(async () => new Response('{"message":"secondary rate limit"}', {
      status: 403, headers: { 'retry-after': '60' },
    }))
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 1 })
    const err = await http.json('https://api.github.com/repos/a/b').catch(e => e as Error)
    expect(err).toBeInstanceOf(HttpError)
    expect(err).not.toBeInstanceOf(RateLimitError)
  })
})
