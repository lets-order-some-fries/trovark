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

/**
 * The caller's own API budget is exhausted (403/429 carrying
 * `x-ratelimit-remaining: 0`).
 *
 * This is a fact about the machine running trovark, not about the repository
 * being scanned, so it must never be folded into a scorecard as though the
 * server were unanalysable. Without the distinction the second token-less scan
 * in an hour reports INSUFFICIENT DATA about a repo that grades A+ with a token
 * present, and says nothing about GITHUB_TOKEN.
 *
 * Deliberately narrow: GitHub's SECONDARY rate limit does not send
 * `remaining: 0`, and the index scanner is right to treat those as transient
 * and retry them. Only primary-budget exhaustion is typed here.
 */
export class RateLimitError extends HttpError {
  /** Unix seconds at which the budget refills, from `x-ratelimit-reset`. */
  readonly resetEpoch: number | undefined
  constructor(status: number, url: string, resetEpoch: number | undefined) {
    super(status, url)
    this.name = 'RateLimitError'
    this.resetEpoch = resetEpoch
  }
}

/**
 * GitHub rejected the caller's GITHUB_TOKEN: HTTP 401 on a request that
 * carried it. Deliberately narrow — a 401 on a request that sent no token,
 * or from any host the token is never attached to, stays an ordinary
 * HttpError, because there is no credential of ours to blame for it.
 *
 * Like RateLimitError this is a fact about the machine running trovark, not
 * about the ref. Measured before it existed: GITHUB_TOKEN=ghp_definitelybogus
 * scanned modelcontextprotocol/servers (A- with a working token) into exit 2,
 * "insufficient data to score this ref", four "not measured" dimensions and
 * a note reading "github: HTTP 401 for <url>" as the only clue.
 */
export class AuthError extends HttpError {
  constructor(status: number, url: string) {
    super(status, url)
    this.name = 'AuthError'
  }
}

/**
 * Re-throws an error that describes the machine running trovark rather than
 * the ref being scanned, so a fail-soft catch cannot absorb it. Two such
 * errors exist: an exhausted API budget (RateLimitError) and a rejected
 * credential (AuthError).
 *
 * The collectors deliberately swallow most failures — one flaky call should
 * cost one signal, not the whole scan. An exhausted budget is not a flaky
 * call: every later request fails the same way, and each swallowed one
 * leaves a signal undefined that then gets scored as a partial card ABOUT
 * THE REPO. Measured before this helper existed: a rate limit on the second
 * API call (the commits page) published a confident A- with health 100/100;
 * on the last call (the tree) it published INSUFFICIENT DATA blaming the
 * ref. Only the very first call was reported honestly. Every catch that
 * wraps a request goes through here first; anything else keeps its
 * fail-soft behaviour untouched.
 */
export function rethrowIfCallerSide(err: unknown): void {
  if (err instanceof RateLimitError || err instanceof AuthError) throw err
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
        // A 401 on a request that carried our token is the token being
        // rejected; retrying it cannot help and the caller must be told.
        if (res.status === 401 && headers.authorization !== undefined) throw new AuthError(res.status, url)
        // An exhausted budget cannot be waited out in 250ms, so it is thrown
        // immediately rather than retried, whatever the status carrying it.
        if ((res.status === 403 || res.status === 429) &&
            res.headers.get('x-ratelimit-remaining') === '0') {
          const rawReset = res.headers.get('x-ratelimit-reset')
          const reset = rawReset === null ? undefined : Number(rawReset)
          throw new RateLimitError(res.status, url,
            reset !== undefined && Number.isFinite(reset) ? reset : undefined)
        }
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
