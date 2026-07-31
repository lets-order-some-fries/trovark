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
})
