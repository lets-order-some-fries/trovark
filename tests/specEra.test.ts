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
  // C1: SDK 2.x package split — @modelcontextprotocol/core, /server, /client
  // replace the single @modelcontextprotocol/sdk package. These only exist
  // post-split (2025+), so — like the Go/Rust/JVM/.NET branches — merely
  // detecting the dependency at all (regardless of version range) is modern.
  it('modern for @modelcontextprotocol/server (SDK 2.x split) in package.json, regardless of a beta version range', () => {
    expect(specEra([{ path: 'package.json', content: JSON.stringify({ dependencies: { '@modelcontextprotocol/server': '2.0.0-beta.4' } }) }])).toBe('modern')
  })
  it('modern for @modelcontextprotocol/core (SDK 2.x split) in package.json', () => {
    expect(specEra([{ path: 'package.json', content: JSON.stringify({ dependencies: { '@modelcontextprotocol/core': '2.0.0-beta.4' } }) }])).toBe('modern')
  })
  it('modern for @modelcontextprotocol/client (SDK 2.x split) in devDependencies', () => {
    expect(specEra([{ path: 'package.json', content: JSON.stringify({ devDependencies: { '@modelcontextprotocol/client': '2.0.0' } }) }])).toBe('modern')
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

  // False positives: a mere mention in keywords/description/comments must NOT read as 'modern'.
  it('undefined for fastmcp only mentioned in pyproject keywords/description, not as a dependency', () => {
    expect(specEra([{ path: 'pyproject.toml', content: 'keywords = ["fastmcp"]\ndescription = "an alternative to fastmcp"' }])).toBeUndefined()
  })
  it('undefined for rmcp only mentioned in Cargo.toml keywords, not as a dependency', () => {
    expect(specEra([{ path: 'Cargo.toml', content: '[package]\nkeywords = ["rmcp"]' }])).toBeUndefined()
  })
  it('undefined for a commented-out ModelContextProtocol PackageReference in .csproj', () => {
    expect(specEra([{ path: 'MyServer.csproj', content: '<!-- <PackageReference Include="ModelContextProtocol" Version="0.1"/> -->' }])).toBeUndefined()
  })
  it('undefined for go.mod SDK path only appearing in a comment', () => {
    expect(specEra([{ path: 'go.mod', content: 'module x\n\n// require github.com/modelcontextprotocol/go-sdk v1.0.0 (considered, not used)\nrequire github.com/spf13/cobra v1.8.0\n' }])).toBeUndefined()
  })
  it('undefined for io.modelcontextprotocol only appearing in a commented-out gradle line', () => {
    expect(specEra([{ path: 'build.gradle', content: '// implementation("io.modelcontextprotocol:mcp:0.1.0")' }])).toBeUndefined()
  })
  it('undefined for fastmcp mentioned only inside a multi-line TOML triple-quoted description', () => {
    expect(specEra([{
      path: 'pyproject.toml',
      content: 'description = """\nA drop-in alternative to fastmcp\n"""\ndependencies = ["httpx"]',
    }])).toBeUndefined()
  })
  it('still modern for a real fastmcp dependency alongside an unrelated multi-line TOML description', () => {
    expect(specEra([{
      path: 'pyproject.toml',
      content: 'description = """\nSome multi-line blurb\nabout this package\n"""\ndependencies = ["fastmcp>=2.0"]',
    }])).toBe('modern')
  })
})
