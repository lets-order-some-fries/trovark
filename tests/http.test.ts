import { describe, expect, it, vi } from 'vitest'
import { AuthError, createHttp, HttpError, RateLimitError } from '../src/util/http.js'

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

// A 401 on a request that carried the caller's token means GitHub rejected
// THAT TOKEN. It is a fact about this machine's credential, not the ref, so
// it is typed — like RateLimitError — instead of degrading into a collector
// error that the CLI reports as INSUFFICIENT DATA about the repository.
describe('createHttp — a rejected token is typed, not folded into the scan', () => {
  it('types a 401 on a token-bearing GitHub request as AuthError and does not retry it', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"message":"Bad credentials"}', { status: 401 }))
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, githubToken: 'ghp_definitelybogus', retries: 2 })
    await expect(http.json('https://api.github.com/repos/a/b')).rejects.toBeInstanceOf(AuthError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('leaves a 401 on a request that carried no token as an ordinary HttpError', async () => {
    // Without a token there is no credential to blame; whatever a registry
    // means by 401 here, it is not "your GITHUB_TOKEN was rejected".
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }))
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 })
    const err = await http.json('https://api.github.com/repos/a/b').catch(e => e as Error)
    expect(err).toBeInstanceOf(HttpError)
    expect(err).not.toBeInstanceOf(AuthError)
  })
  it('leaves a 401 from a non-GitHub host as an ordinary HttpError even when a token is configured', async () => {
    // The token is only ever attached to api.github.com, so a 401 elsewhere
    // cannot be about it.
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }))
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, githubToken: 'T', retries: 0 })
    const err = await http.json('https://registry.npmjs.org/x').catch(e => e as Error)
    expect(err).toBeInstanceOf(HttpError)
    expect(err).not.toBeInstanceOf(AuthError)
  })
})

// The deadline used to cover only the HEADERS. `request()` returned the
// moment they arrived and its `finally { clearTimeout(timer) }` disarmed the
// AbortController at the same instant, so every `.text()`/`.json()` in the
// wrappers read the body with no deadline and no armed signal. Measured
// against a local server that sends 200 + headers + 5 bytes and never calls
// res.end(): still pending at 60s, 150s, 250s, 295s, and rejected only at
// 305s with `TypeError: terminated (UND_ERR_BODY_TIMEOUT)` — undici's own
// 300_000ms default, i.e. a property of whatever fetch was handed in rather
// than of createHttp, which is exactly the guarantee the comment above the
// race claims to provide. With github.ts fetching up to 12 files in sequence
// and scan.ts pooling refs four at a time with no per-ref deadline, one
// stalled body is five minutes of silence from a CLI whose whole UX is a
// fast grade.
//
// The deadline is now two-phase: the existing timer bounds the headers, and
// a per-chunk IDLE timer bounds the body. It is deliberately NOT a
// total-duration budget — see the slow-but-progressing test below.
describe('createHttp — the deadline covers the body, not just the headers', () => {
  /** 200 + headers, one chunk, then silence forever: the stalled-body case. */
  const stalledBody = () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('hello')) }, // never close()
  }), { status: 200 })

  it('rejects a body that stalls after the headers instead of waiting on the fetch implementation', async () => {
    const http = createHttp({ fetchImpl: (async () => stalledBody()) as unknown as typeof fetch, retries: 0, timeoutMs: 50 })
    const started = Date.now()
    await expect(http.text('https://x.test/stall')).rejects.toThrow(/body stalled after 50ms/)
    // Generous bound (40x the idle budget): the point is that it settles on
    // OUR deadline at all, not the wall-clock number.
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('rejects a stalled body through json() too, not only text()', async () => {
    const http = createHttp({ fetchImpl: (async () => stalledBody()) as unknown as typeof fetch, retries: 0, timeoutMs: 50 })
    await expect(http.json('https://x.test/stall')).rejects.toThrow(/body stalled after 50ms/)
  })

  // The property that rules out the obvious wrong fix. A total-duration
  // deadline would reject this, and would start failing the large monolithic
  // `dist/index.js` entrypoints that `fetchable` deliberately lets through on
  // a slow link. An IDLE deadline lets it finish: measured, a ~6s drip under
  // a 2s idle budget resolved OK at 6020ms.
  it('lets a slow but progressing body finish even when it outlasts timeoutMs in total', async () => {
    const chunks = 6, gapMs = 20, idleMs = 100 // total ≈ 120ms > idleMs, per-gap < idleMs
    const fetchImpl = async () => new Response(new ReadableStream({
      async start(c) {
        for (let i = 0; i < chunks; i++) {
          await new Promise(r => setTimeout(r, gapMs))
          c.enqueue(new TextEncoder().encode('chunk'))
        }
        c.close()
      },
    }), { status: 200 })
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0, timeoutMs: idleMs })
    const started = Date.now()
    expect(await http.text('https://x.test/drip')).toBe('chunk'.repeat(chunks))
    expect(Date.now() - started).toBeGreaterThanOrEqual(chunks * gapMs) // it really did outlast a total budget
  })

  it('still reads a whole multi-chunk body verbatim, boundaries and all', async () => {
    // Reassembly must be byte-exact across chunk boundaries, including a
    // multi-byte character split across two chunks.
    const bytes = new TextEncoder().encode('héllo wörld — ✅')
    const fetchImpl = async () => new Response(new ReadableStream({
      start(c) { c.enqueue(bytes.slice(0, 7)); c.enqueue(bytes.slice(7)); c.close() },
    }), { status: 200 })
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 })
    expect(await http.text('https://x.test/utf8')).toBe('héllo wörld — ✅')
  })

  it('handles an empty 200 body and a null-body 204 without arming anything', async () => {
    const empty = createHttp({ fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch, retries: 0, timeoutMs: 50 })
    expect(await empty.text('https://x.test/empty')).toBe('')
    const noContent = createHttp({ fetchImpl: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch, retries: 0, timeoutMs: 50 })
    expect(await noContent.text('https://x.test/204')).toBe('')
  })

  it('keeps the headers half of the deadline: a fetch that never settles still rejects', async () => {
    const fetchImpl = () => new Promise<Response>(() => {}) // never resolves
    const http = createHttp({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0, timeoutMs: 50 })
    await expect(http.json('https://x.test/hang')).rejects.toThrow(/timeout after 50ms/)
  })
})
