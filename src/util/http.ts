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

interface RequestInitExtra {
  method?: string
  body?: string
  extraHeaders?: Record<string, string>
}

/** Retries only on network errors, 429, and 5xx. Other non-2xx throw immediately. */
export function createHttp(opts: HttpOptions = {}): Http {
  const { githubToken, retries = 2, timeoutMs = 10_000, fetchImpl = fetch } = opts

  async function request(url: string, init: RequestInitExtra = {}): Promise<Response> {
    const headers: Record<string, string> = { 'user-agent': 'trovark', ...init.extraHeaders }
    if (githubToken && new URL(url).hostname === 'api.github.com') headers.authorization = `Bearer ${githubToken}`
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res: Response | undefined
      try {
        res = await fetchImpl(url, {
          method: init.method,
          body: init.body,
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        lastErr = err // network / timeout errors are retryable
      }
      if (res) {
        if (res.ok) return res
        const httpErr = new Error(`HTTP ${res.status} for ${url}`)
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
