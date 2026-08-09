export interface Http {
  json<T>(url: string): Promise<T>
  /** Like json(), but also returns response headers (e.g. to read `Link` for pagination). Same retry/timeout path. */
  jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }>
  text(url: string): Promise<string>
  postJson<T>(url: string, body: unknown): Promise<T>
}

export interface HttpOptions {
  githubToken?: string
  retries?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * A non-2xx HTTP response, carrying the numeric status so callers can
 * distinguish e.g. a 404 (resource genuinely gone) from a 403/401/5xx
 * (auth/infra trouble) without parsing the message string. See
 * src/collectors/github.ts (RepoNotFoundError) for the first consumer —
 * a 404 specifically on repo metadata means "repo deleted/renamed", which
 * must be reported as a distinct outcome, never as a generic collector error.
 */
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`)
    this.name = 'HttpError'
    this.status = status
  }
}

interface RequestInitExtra {
  method?: string
  body?: string
  extraHeaders?: Record<string, string>
}

/**
 * Retries only on network errors, 429, and 5xx. Other non-2xx throw immediately.
 *
 * Redirects (coverage-v1.4 W1): neither `request()` nor its callers set
 * `redirect: 'manual'`, so `fetchImpl` (the real global `fetch` in
 * production) follows 3xx transparently per the WHATWG fetch spec default —
 * a GitHub repo-metadata 301 (rename) is already resolved to its 200 target
 * before this function ever sees a status code. A genuine 404 (deleted repo,
 * or a rename GitHub no longer redirects) is the only case that reaches the
 * throw below — see src/collectors/github.ts's RepoNotFoundError, which is
 * exactly that "one rename redirect already followed, true 404 remains" case.
 */
export function createHttp(opts: HttpOptions = {}): Http {
  const { githubToken, retries = 2, timeoutMs = 10_000, fetchImpl = fetch } = opts

  async function request(url: string, init: RequestInitExtra = {}): Promise<Response> {
    const headers: Record<string, string> = { 'user-agent': 'trovark', ...init.extraHeaders }
    if (githubToken && new URL(url).hostname === 'api.github.com') headers.authorization = `Bearer ${githubToken}`
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res: Response | undefined
      // Fault hunt 2026-08-08 (C6): this used AbortSignal.timeout(), whose
      // internal timer is UNREF'd — Node does not count it as pending work.
      // When every in-flight fetch stalls and nothing else keeps the loop
      // alive, the process exits before any timeout can fire, and a
      // top-level `await main()` never settles. Observed exactly that: a
      // 400-server scan printed "Detected unsettled top-level await" at
      // 150/400 and exited 0 having written nothing, which is
      // indistinguishable from a clean no-change run. A ref'd setTimeout
      // driving an AbortController keeps the loop alive so the deadline
      // actually fires and the request rejects as a retryable error.
      const ac = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      // The deadline is a RACE, not just an abort signal. Aborting only ends
      // the request if the fetch implementation honours the signal; racing a
      // ref'd timer guarantees the attempt ends either way, which is what
      // makes "the scan cannot hang forever" a property of this function
      // rather than a property of whatever fetch it was handed.
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort()   // best-effort cancellation of the underlying request
          reject(new Error(`timeout after ${timeoutMs}ms: ${url}`))
        }, timeoutMs)
      })
      try {
        res = await Promise.race([
          fetchImpl(url, { method: init.method, body: init.body, headers, signal: ac.signal }),
          deadline,
        ])
      } catch (err) {
        lastErr = err // network / timeout errors are retryable
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (res) {
        if (res.ok) return res
        const httpErr = new HttpError(res.status, url)
        if (res.status === 429 || res.status >= 500) lastErr = httpErr // retryable
        else throw httpErr // other non-2xx: fail immediately
      }
      if (attempt < retries) await new Promise(r => setTimeout(r, 250 * 2 ** attempt))
    }
    throw lastErr
  }

  return {
    async json<T>(url: string): Promise<T> { return (await request(url)).json() as Promise<T> },
    async jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }> {
      const res = await request(url)
      return { data: (await res.json()) as T, headers: res.headers }
    },
    async text(url: string): Promise<string> { return (await request(url)).text() },
    async postJson<T>(url: string, body: unknown): Promise<T> {
      const res = await request(url, {
        method: 'POST',
        body: JSON.stringify(body),
        extraHeaders: { 'content-type': 'application/json' },
      })
      return res.json() as Promise<T>
    },
  }
}
