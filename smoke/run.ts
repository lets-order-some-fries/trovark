// Manual calibration: npx tsx smoke/run.ts   (set GITHUB_TOKEN first)
import { readFileSync } from 'node:fs'
import { createHttp } from '../src/util/http.js'
import { resolve } from '../src/resolver.js'
import { assemble } from '../src/assemble.js'
import { score } from '../src/scoring/score.js'

const refs = readFileSync(new URL('./servers.txt', import.meta.url), 'utf8').trim().split('\n')
const http = createHttp({ githubToken: process.env.GITHUB_TOKEN })
const now = new Date()

for (const ref of refs) {
  try {
    const id = await resolve(ref, http)
    const card = score(ref, await assemble(id, http, now, { hasToken: Boolean(process.env.GITHUB_TOKEN) }), now.toISOString())
    console.log(`${card.grade.padEnd(3)} ${String(card.overall).padStart(3)}  ${ref}`)
  } catch (err) {
    console.log(`ERR      ${ref}  (${(err as Error).message})`)
  }
}
