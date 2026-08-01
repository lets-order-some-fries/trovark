import { encode } from 'gpt-tokenizer'
import type { RepoFile } from '../collectors/github.js'
import type { Finding, ToolInfo } from '../types.js'

export interface SchemaResult {
  extracted: boolean
  tools: ToolInfo[]
  toolSurfaceRisk: 'none' | 'low' | 'medium' | 'high' | undefined
  schemaTokenEstimate: number | undefined
  findings: Finding[]
}

type Risk = 'none' | 'low' | 'medium' | 'high'
const RISK_ORDER: Risk[] = ['none', 'low', 'medium', 'high']

const HIGH = /exec|spawn|shell|child_process|subprocess|os\.system|eval\(/i
const MEDIUM = /write|delete|remove|unlink|\brm\b|drop/i
const LOW = /fetch|http|request|url|download/i

function classify(text: string): Risk {
  if (HIGH.test(text)) return 'high'
  if (MEDIUM.test(text)) return 'medium'
  if (LOW.test(text)) return 'low'
  return 'none'
}

function fromManifest(f: RepoFile): ToolInfo[] {
  try {
    const doc = JSON.parse(f.content) as { tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }> }
    if (!Array.isArray(doc.tools)) return []
    return doc.tools
      .filter((t): t is { name: string; description?: string; inputSchema?: unknown } => typeof t.name === 'string')
      .map(t => ({ name: t.name, description: t.description, schemaText: JSON.stringify(t) }))
  } catch { return [] }
}

function fromJsSource(f: RepoFile): ToolInfo[] {
  const tools: ToolInfo[] = []
  for (const m of f.content.matchAll(/\.tool\(\s*["'`]([\w-]+)["'`]\s*(?:,\s*["'`]([^"'`]*)["'`])?/g)) {
    tools.push({ name: m[1], description: m[2], schemaText: m[0] })
  }
  if (f.content.includes('ListToolsRequestSchema')) {
    for (const m of f.content.matchAll(/name:\s*["'`]([\w-]+)["'`]/g)) {
      if (!tools.some(t => t.name === m[1])) tools.push({ name: m[1], schemaText: m[0] })
    }
  }
  return tools
}

function fromPySource(f: RepoFile): ToolInfo[] {
  const tools: ToolInfo[] = []
  for (const m of f.content.matchAll(/@\w+\.tool\([^)]*\)\s*\n\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/g)) {
    tools.push({ name: m[1], schemaText: m[0] })
  }
  return tools
}

export function extractSchema(files: RepoFile[]): SchemaResult {
  const manifest = files.filter(f => /(^|\/)(mcp|server)\.json$/.test(f.path))
  const js = files.filter(f => /\.(ts|js|mjs)$/.test(f.path))
  const py = files.filter(f => f.path.endsWith('.py'))

  let tools: Array<ToolInfo & { evidence: string }> = []
  for (const level of [
    () => manifest.flatMap(f => fromManifest(f).map(t => ({ ...t, evidence: f.path }))),
    () => js.flatMap(f => fromJsSource(f).map(t => ({ ...t, evidence: f.path }))),
    () => py.flatMap(f => fromPySource(f).map(t => ({ ...t, evidence: f.path }))),
  ]) {
    tools = level()
    if (tools.length > 0) break
  }

  if (tools.length === 0) {
    return { extracted: false, tools: [], toolSurfaceRisk: undefined, schemaTokenEstimate: undefined, findings: [] }
  }

  const findings: Finding[] = []
  let worst: Risk = 'none'
  for (const t of tools) {
    const risk = classify(`${t.name} ${t.description ?? ''} ${t.schemaText}`)
    if (RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(worst)) worst = risk
    if (risk === 'high') {
      findings.push({
        id: 'security/shell-exec-tool', dimension: 'security', severity: 'high',
        message: `Tool "${t.name}" appears to execute commands or code.`, evidence: t.evidence,
      })
    } else if (risk === 'medium') {
      findings.push({
        id: 'security/destructive-tool', dimension: 'security', severity: 'medium',
        message: `Tool "${t.name}" appears to write or delete data.`, evidence: t.evidence,
      })
    }
  }

  return {
    extracted: true,
    tools: tools.map(({ evidence: _e, ...t }) => t),
    toolSurfaceRisk: worst,
    schemaTokenEstimate: encode(JSON.stringify(tools.map(({ evidence: _e, ...t }) => t))).length,
    findings,
  }
}
