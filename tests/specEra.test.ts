import { describe, expect, it } from 'vitest'
import { specEra } from '../src/derive/specEra.js'

describe('specEra', () => {
  it('modern for SDK >=1.0 in package.json', () => {
    expect(specEra([{ path: 'package.json', content: JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.12.0' } }) }])).toBe('modern')
  })
  it('legacy for SDK <1.0', () => {
    expect(specEra([{ path: 'package.json', content: JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '~0.6.1' } }) }])).toBe('legacy')
  })
  it('modern for python mcp>=1.0 in pyproject', () => {
    expect(specEra([{ path: 'pyproject.toml', content: 'dependencies = ["mcp>=1.2.0", "httpx"]' }])).toBe('modern')
  })
  it('legacy for python mcp 0.x', () => {
    expect(specEra([{ path: 'pyproject.toml', content: 'dependencies = ["mcp==0.9.1"]' }])).toBe('legacy')
  })
  it('undefined when no MCP SDK dependency found', () => {
    expect(specEra([{ path: 'package.json', content: '{"dependencies":{"express":"^4.0.0"}}' }])).toBeUndefined()
  })
  it('undefined on malformed package.json', () => {
    expect(specEra([{ path: 'package.json', content: 'not json' }])).toBeUndefined()
  })
  it('modern for unquoted mcp at the very start of requirements.txt', () => {
    expect(specEra([{ path: 'requirements.txt', content: 'mcp>=1.2.0\nhttpx>=0.24' }])).toBe('modern')
  })
})
