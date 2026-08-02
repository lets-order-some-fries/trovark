import { describe, expect, it } from 'vitest'
import { fromGoSource } from '../src/derive/lang/go.js'
import { extractSchema } from '../src/derive/schema.js'

describe('fromGoSource — idiom 1: official go-sdk composite literal mcp.Tool{...}', () => {
  it('extracts name + description (translation-helper 2nd arg) from github-mcp-server-shaped source', () => {
    const content = `
func GetFileContents(getClient GetClientFn, t translations.TranslationHelperFunc) (mcp.Tool, server.ToolHandlerFunc) {
	return mcp.Tool{
			Name: "get_file_contents",
			Description: t("TOOL_GET_FILE_CONTENTS_DESCRIPTION", "Get the contents of a file or directory from a GitHub repository"),
			InputSchema: mcp.ToolInputSchema{
				Type: "object",
				Properties: map[string]any{
					"owner": map[string]any{
						"type":        "string",
						"description": "Repository owner",
					},
				},
			},
		},
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return nil, nil
		}
}
`
    const tools = fromGoSource({ path: 'pkg/github/repositories.go', content })
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('get_file_contents')
    expect(tools[0].description).toBe('Get the contents of a file or directory from a GitHub repository')
  })

  it('falls back to the plain Description string literal when there is no t(...) helper', () => {
    const content = `
	return mcp.Tool{
		Name: "list_issues",
		Description: "List issues in a repository",
	}
`
    const tools = fromGoSource({ path: 'pkg/github/issues.go', content })
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ name: 'list_issues', description: 'List issues in a repository' })
  })
})

describe('fromGoSource — idiom 2: mark3labs call form NewTool(name, mcp.WithDescription(...))', () => {
  it('extracts name + description from the adjacent WithDescription() option', () => {
    const content = `
func SearchProviders() mcp.Tool {
	return mcp.NewTool("search_providers",
		mcp.WithDescription(` + '`This tool searches for Terraform providers on the Terraform Registry.`' + `),
		mcp.WithString("registry_name", mcp.Description("The name of the registry")),
	)
}
`
    const tools = fromGoSource({ path: 'pkg/tools/providers.go', content })
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('search_providers')
    expect(tools[0].description).toBe('This tool searches for Terraform providers on the Terraform Registry.')
  })
})

describe('fromGoSource — idiom 3: mark3labs positional MustTool(name, desc)', () => {
  it('extracts name + description in one shot', () => {
    // mcp-grafana-shaped: MustTool is always package-qualified
    // (mcpgrafana.MustTool) and the file also carries an mcp.With*
    // annotation from the mark3labs/mcp-go SDK it wraps.
    const content = `
var SearchDashboardsTool = mcpgrafana.MustTool(
	"search_dashboards",
	"Search for Grafana dashboards by title, tag, or folder",
	searchDashboardsHandler,
	mcp.WithReadOnlyHintAnnotation(true),
)
`
    const tools = fromGoSource({ path: 'tools/search.go', content })
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      name: 'search_dashboards',
      description: 'Search for Grafana dashboards by title, tag, or folder',
    })
  })
})

describe('fromGoSource — idiom 4: genai-toolbox self-register', () => {
  it('extracts name from resourceType const + description from the .Description assignment', () => {
    const content = `
const resourceType string = "alloydb-create-user"

func init() {
	tools.Register(resourceType, func() Tool {
		cfg := &Config{}
		cfg.Description = "Creates a new AlloyDB user with the given credentials."
		return cfg
	})
}
`
    const tools = fromGoSource({ path: 'internal/tools/alloydbcreateuser/tool.go', content })
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      name: 'alloydb-create-user',
      description: 'Creates a new AlloyDB user with the given credentials.',
    })
  })

  it('does not fire when there is no tools.Register( signal (guards the resourceType/Description regexes)', () => {
    const content = `
const resourceType string = "unrelated-const"

func something() {
	cfg.Description = "Not actually a tool registration"
}
`
    const tools = fromGoSource({ path: 'internal/other/thing.go', content })
    expect(tools).toEqual([])
  })
})

describe('fromGoSource — dedup + malformed input', () => {
  it('dedupes the same tool name matched by more than one idiom', () => {
    const content = `
mcp.NewTool("search_dashboards", "Search for Grafana dashboards by title, tag, or folder")
`
    const tools = fromGoSource({ path: 'tools/search.go', content })
    // The positional MustTool/NewTool regex and the NewTool-call-form regex
    // can both match this line; dedup must keep a single entry.
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('search_dashboards')
  })

  it('malformed/non-idiomatic Go source yields no tools', () => {
    const content = `
package main

import "fmt"

func main() {
	fmt.Println("hello world")
}
`
    const tools = fromGoSource({ path: 'main.go', content })
    expect(tools).toEqual([])
  })
})

describe('fromGoSource — MCP-relatedness gate (phantom-tool guard)', () => {
  it('does not fabricate a tool from an unrelated NewTool constructor with no MCP marker', () => {
    // A bare, unrelated domain constructor that happens to share the name
    // NewTool with the mark3labs idiom. Nothing here references an MCP SDK,
    // so this must not be mistaken for a tool registration.
    const content = `
package inventory

type Tool struct {
	Name string
	Kind string
}

func NewTool(name, kind string) *Tool {
	return &Tool{Name: name, Kind: kind}
}

var hammer = NewTool("hammer", "striking")
`
    const tools = fromGoSource({ path: 'internal/inventory/tool.go', content })
    expect(tools).toEqual([])
  })

  it('extracts a qualified mcp.NewTool call once the file carries an MCP SDK marker', () => {
    const content = `
func RealTool() mcp.Tool {
	return mcp.NewTool("real_tool", mcp.WithDescription(` + '`does X`' + `))
}
`
    const tools = fromGoSource({ path: 'pkg/tools/real.go', content })
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ name: 'real_tool', description: 'does X' })
  })
})

describe('extractSchema wiring — .go files dispatch to fromGoSource', () => {
  it('extracts tools from a .go file and classifies risk through the shared token-set path', () => {
    const r = extractSchema([{
      path: 'tools/search.go',
      content: `
var SearchDashboardsTool = mcpgrafana.MustTool(
	"search_dashboards",
	"Search for Grafana dashboards by title, tag, or folder",
	searchDashboardsHandler,
	mcp.WithReadOnlyHintAnnotation(true),
)
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['search_dashboards'])
    expect(r.toolSurfaceRisk).toBe('low') // "search"
  })

  it('a .go tool tiers as medium through the shared classify() path (call_tool_destructive tiers correctly)', () => {
    const r = extractSchema([{
      path: 'pkg/github/issues.go',
      content: `
	return mcp.Tool{
		Name: "delete_issue_comment",
		Description: "Delete a comment on an issue",
	}
`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.toolSurfaceRisk).toBe('medium') // delete
  })

  it('a repo with only a non-.go source file is unaffected (regression: go bucket must not swallow js/py)', () => {
    const r = extractSchema([{
      path: 'src/index.ts',
      content: `server.tool('list_files', 'List directory contents', {}, handler)`,
    }])
    expect(r.extracted).toBe(true)
    expect(r.tools.map(t => t.name)).toEqual(['list_files'])
  })
})
