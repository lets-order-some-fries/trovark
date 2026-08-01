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
  it('modern for fastmcp in pyproject dependencies', () => {
    expect(specEra([{ path: 'pyproject.toml', content: 'dependencies = ["fastmcp>=2.0.0"]' }])).toBe('modern')
  })
  it('modern for fastmcp-slim in pyproject dependencies', () => {
    expect(specEra([{ path: 'pyproject.toml', content: 'dependencies = ["fastmcp-slim"]' }])).toBe('modern')
  })
  it('modern for go.mod requiring the official MCP go-sdk', () => {
    expect(specEra([{ path: 'go.mod', content: 'module x\n\nrequire github.com/modelcontextprotocol/go-sdk v0.1.0\n' }])).toBe('modern')
  })
  it('modern for go.mod requiring mark3labs/mcp-go', () => {
    expect(specEra([{ path: 'go.mod', content: 'module x\n\nrequire github.com/mark3labs/mcp-go v0.20.0\n' }])).toBe('modern')
  })
  it('undefined for a go.mod with no MCP SDK', () => {
    expect(specEra([{ path: 'go.mod', content: 'module x\n\nrequire github.com/spf13/cobra v1.8.0\n' }])).toBeUndefined()
  })
  it('modern for Cargo.toml requiring rmcp', () => {
    expect(specEra([{ path: 'Cargo.toml', content: '[dependencies]\nrmcp = "0.1"\n' }])).toBe('modern')
  })
  it('modern for build.gradle.kts with io.modelcontextprotocol', () => {
    expect(specEra([{ path: 'build.gradle.kts', content: 'implementation("io.modelcontextprotocol:mcp:0.1.0")' }])).toBe('modern')
  })
  it('modern for pom.xml with io.modelcontextprotocol', () => {
    expect(specEra([{ path: 'pom.xml', content: '<groupId>io.modelcontextprotocol</groupId><artifactId>mcp</artifactId>' }])).toBe('modern')
  })
  it('modern for a .csproj referencing ModelContextProtocol', () => {
    expect(specEra([{ path: 'src/Server.csproj', content: '<PackageReference Include="ModelContextProtocol" Version="0.1.0" />' }])).toBe('modern')
  })
})
