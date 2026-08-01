import { describe, expect, it } from 'vitest'
import { extractRepoRefs } from '../index/discover.js'

describe('extractRepoRefs', () => {
  it('extracts owner/repo from github links in markdown', () => {
    const md = `
- [Foo](https://github.com/acme/foo-mcp) — does foo
- [Bar](https://github.com/beta/bar-mcp/) trailing slash
- deep link https://github.com/acme/foo-mcp/blob/main/README.md (same repo)
`
    expect(extractRepoRefs(md).sort()).toEqual(['acme/foo-mcp', 'beta/bar-mcp'])
  })
  it('strips .git, query strings and anchors', () => {
    const md = 'https://github.com/a/b.git https://github.com/c/d?tab=readme #x https://github.com/e/f#section'
    expect(extractRepoRefs(md).sort()).toEqual(['a/b', 'c/d', 'e/f'])
  })
  it('ignores non-repo github paths and awesome-list repos', () => {
    const md = `
https://github.com/topics/mcp
https://github.com/sponsors/whoever
https://github.com/features/actions
https://github.com/punkpeye/awesome-mcp-servers
https://github.com/acme/real-server
`
    expect(extractRepoRefs(md)).toEqual(['acme/real-server'])
  })
  it('dedupes case-insensitively, keeps first casing', () => {
    const md = 'https://github.com/Acme/Foo https://github.com/acme/foo'
    expect(extractRepoRefs(md)).toEqual(['Acme/Foo'])
  })
})
