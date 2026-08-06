import { createHttp } from './src/util/http.js'
import { resolve } from './src/resolver.js'
import { assemble } from './src/assemble.js'
import { score } from './src/scoring/score.js'

const refs = process.argv.slice(2)
const http = createHttp({ githubToken: process.env.GITHUB_TOKEN })
const now = new Date('2026-08-06T00:00:00Z')
for (const ref of refs) {
  try {
    const id = await resolve(ref, http)
    const s = await assemble(id, http, now, { hasToken: true })
    const c = score(ref, s, now.toISOString())
    console.log(JSON.stringify({
      ref, overall: c.overall, grade: c.grade, insuf: c.insufficientData,
      notServer: c.notServer, reason: c.notServerReason, readmeSourced: c.readmeSourced,
      risk: s.toolSurfaceRisk, toolCount: s.toolCount, schemaExtracted: s.schemaExtracted,
      dims: c.dimensions.map(d => `${d.id}:${d.score}/${d.confidence}`),
      sec: s.findings.filter(f => f.dimension === 'security').map(f => f.id),
      rel: s.findings.filter(f => f.dimension === 'reliability').map(f => f.id),
    }))
  } catch (e) { console.log(JSON.stringify({ ref, err: (e as Error).message })) }
}
