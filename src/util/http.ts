export interface Http {
  json<T>(url: string): Promise<T>
  text(url: string): Promise<string>
}

export interface HttpOptions {
  githubToken?: string
  retries?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** Retries only on network errors, 429, and 5xx. Other non-2xx throw immediately. */
export function createHttp(opts: HttpOptions = {}): Http {
  const { githubToken, retries = 2, timeoutMs = 10_000, fetchImpl = fetch } = opts

  async function request(url: string): Promise<Response> {
    const headers: Record<string, string> = { 'user-agent': 'mcpscore' }
    if (githubToken && new URL(url).hostname === 'api.github.com') headers.authorization = `Bearer ${githubToken}`
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status} for ${url}`)
        } else if (!res.ok) {
          throw new Error(`HTTP ${res.status} for ${url}`)
        } else {
          return res
        }
      } catch (err) {
        if (err instanceof Error && /^HTTP 4(?!29)/.test(err.message)) throw err
        lastErr = err
      }
      if (attempt < retries) await new Promise(r => setTimeout(r, 250 * 2 ** attempt))
    }
    throw lastErr
  }

  return {
    async json<T>(url: string): Promise<T> { return (await request(url)).json() as Promise<T> },
    async text(url: string): Promise<string> { return (await request(url)).text() },
  }
}
