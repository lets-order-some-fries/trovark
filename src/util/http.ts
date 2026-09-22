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
 * Reads a response body under a per-chunk IDLE deadline, aborting the
 * request through the SAME AbortController that bounded the headers.
 *
 * Why idle and not total duration: `fetchable` deliberately lets an
 * entrypoint of any size through (V1 change 5 exists to grade monolithic
 * bundled `dist/index.js` files), and timeoutMs defaults to 10s, so a total
 * budget would start failing multi-MB downloads that work today on a slow
 * link. Measured against a local server that drips one chunk per 300ms for
 * ~6s: a 2s TOTAL budget must kill it, while under a 2s IDLE budget it
 * resolved complete at 6331ms. Idle is the only variant that bounds the
 * stall without breaking the slow download.
 */
async function readBody(res: Response, ac: AbortController, idleMs: number, url: string): Promise<string> {
  if (res.body === null) return '' // 204/304 and other bodiless responses
  const reader = res.body.getReader()
  // Decoded incrementally rather than accumulated and joined: holding every
  // chunk, then a joined Uint8Array, then the string peaks at ~3x the body.
  // Measured peak rss, one read per fresh process, this readBody vs the
  // res.text() it replaces: 1MB 57/58, 20MB 162/184, 60MB 324/386, 100MB
  // (GitHub's blob ceiling) 430/584 — so streaming the decode is no worse
  // than the old path anywhere, and better where it matters. `stream: true`
  // also carries a multi-byte character split across a chunk boundary
  // correctly, which a per-chunk decode would corrupt.
  const decoder = new TextDecoder()
  let out = ''
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined
      // Same ref'd-setTimeout discipline as the headers deadline above (C6):
      // an unref'd timer lets the process exit before the deadline fires.
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort() // best-effort cancellation of the underlying request
          reject(new Error(`body stalled after ${idleMs}ms: ${url}`))
        }, idleMs)
      })
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await Promise.race([reader.read(), idle])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (chunk.done) break
      out += decoder.decode(chunk.value, { stream: true })
    }
    out += decoder.decode() // flush any trailing partial code point
  } catch (err) {
    // ac.abort() makes reader.read() reject first, with the generic
    // "This operation was aborted", so the race surfaces that rather than
    // our message. Normalise it back so the error names the real cause.
    if (ac.signal.aborted) throw new Error(`body stalled after ${idleMs}ms: ${url}`)
    throw err
  } finally {
    reader.cancel().catch(() => {})
  }
  return out
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

  async function request(url: string, init: RequestInitExtra = {}): Promise<{ res: Response; ac: AbortController }> {
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
      //
      // It is TWO-PHASE. This timer bounds the HEADERS only: a Response is
      // returned the moment they arrive, so the body is read afterwards by
      // readBody() under its own per-chunk idle deadline, driving this same
      // AbortController. Before that second phase existed the body had no
      // deadline at all and a stalled one ran to undici's 300_000ms default,
      // 30x what the CLI asks for. A single TOTAL-duration budget covering
      // both phases was rejected on purpose: it would fail the large
      // monolithic entrypoint downloads that `fetchable` (V1 change 5) exists
      // to grade. The `ac` returned alongside the Response is what carries
      // the deadline across the handover.
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
        if (res.ok) return { res, ac }
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

  // Every wrapper reads its body through readBody() rather than
  // res.json()/res.text(), so the idle deadline covers all four. The read
  // stays OUTSIDE the retry loop, exactly where it was: moving it inside
  // would make a stalled body retryable and turn one 10s failure into ~31s
  // across three attempts. Retry semantics are unchanged.
  return {
    async json<T>(url: string): Promise<T> {
      const { res, ac } = await request(url)
      return JSON.parse(await readBody(res, ac, timeoutMs, url)) as T
    },
    async jsonWithHeaders<T>(url: string): Promise<{ data: T; headers: Headers }> {
      const { res, ac } = await request(url)
      return { data: JSON.parse(await readBody(res, ac, timeoutMs, url)) as T, headers: res.headers }
    },
    async text(url: string): Promise<string> {
      const { res, ac } = await request(url)
      return readBody(res, ac, timeoutMs, url)
    },
    async postJson<T>(url: string, body: unknown): Promise<T> {
      const { res, ac } = await request(url, {
        method: 'POST',
        body: JSON.stringify(body),
        extraHeaders: { 'content-type': 'application/json' },
      })
      return JSON.parse(await readBody(res, ac, timeoutMs, url)) as T
    },
  }
}
