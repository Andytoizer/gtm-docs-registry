# GTM Docs Registry

GTM Docs Registry is source-backed documentation retrieval for GTM tools.

It gives AI agents a stable way to resolve a GTM product by name, fetch source-backed operational docs, and decide how to use that tool through its official MCP, CLI, API, OpenAPI/spec, llms.txt, SDK, or community interfaces.

This project is for agent builders, GTM automation systems, and coding agents that need current GTM tool context at runtime. The public homepage includes a searchable catalog so people can see what is covered, but the core product is docs retrieval for agents, not a buying guide, ranking site, marketplace, or workflow recipe library. The agent composes workflows from the docs; GTM Docs Registry supplies the retrieval layer.

## What Is Included

The repository currently contains 197 GTM tool profiles. The hosted catalog shows the 185 published profiles that are ready for retrieval.

```text
registry.json              # Source of truth for available tools
tools/<slug>/tool.json     # Machine-readable profile metadata
tools/<slug>/docs.md       # Retrieval-ready operational notes
tools/<slug>/reference.md  # Optional endpoint/object/schema details
tools/<slug>/sources.json  # Source URLs and verification metadata
bin/gtm-docs.js            # Local CLI
mcp/server.ts              # MCP stdio server
http/server.js             # Read-only HTTP server
scripts/validate-registry.js
scripts/generate-reports.js
scripts/verify-sources.js
scripts/detect-surface-drift.js
scripts/create-draft-profile.js
scripts/run-evals.js
reports/*.md
evals/cases.json
```

The intended agent flow is simple:

```text
resolve-tool-id("hubspot")
get-tool-docs("/gtm/hubspot", topic="contacts API auth")
```

## Install

Requirements:

- Node.js 18 or newer.
- npm.

```bash
npm install
npm run validate
```

## CLI Usage

List available tools:

```bash
npm run cli -- list
```

Resolve a product name, slug, GTM Docs Registry ID, or alias:

```bash
npm run cli -- resolve hubspot
npm run cli -- resolve "hubspot crm"
npm run cli -- resolve /gtm/hubspot
```

Fetch full docs for a tool:

```bash
npm run cli -- docs /gtm/hubspot
```

Fetch docs filtered by a topic string:

```bash
npm run cli -- docs /gtm/smartlead auth
npm run cli -- docs hubspot "contacts API"
```

The topic filter ranks matching sections and appends related source context. If no section strongly matches, the CLI returns high-context fallback sections so the agent still has usable grounding. When `tools/<slug>/reference.md` exists, full docs include it and topic retrieval can match its endpoint tables, schema notes, and auth details.

Fetch source metadata:

```bash
npm run cli -- sources hubspot
```

Search across names, aliases, and docs text:

```bash
npm run cli -- search "hubspot contacts auth"
```

Generate review reports and run deterministic evals:

```bash
npm run reports
npm run test
```

## MCP Usage

Run the local MCP server over stdio:

```bash
npm run mcp
```

The server exposes four tools:

- `resolve-tool-id`: resolves a GTM tool name or alias to its `/gtm/<slug>` ID and registry metadata.
- `get-tool-docs`: returns retrieval-ready documentation for a tool, optionally filtered by topic, with source metadata appended.
- `get-tool-sources`: returns the source metadata for a tool.
- `search-tools`: searches names, aliases, and docs text for ranked tool matches.

It also exposes MCP resources:

- `gtm://registry`
- `gtm://tool/{tool}/docs`
- `gtm://tool/{tool}/sources`

Use it from any MCP-compatible agent by configuring the command to run `npm run mcp` from this repository root.

## HTTP Usage

Hosted production API:

```text
https://gtm-docs-registry.vercel.app
```

Run the read-only HTTP fallback server:

```bash
npm run http
```

The server defaults to `http://localhost:8787` and supports:

```text
GET /
GET /health
GET /catalog
GET /registry
GET /llms.txt
GET /llms-full.txt
GET /openapi.json
GET /mcp
POST /mcp
GET /tools/search?q=hubspot&limit=5
GET /tools/resolve?query=hubspot
GET /tools/hubspot/docs?topic=auth
GET /tools/hubspot/sources
```

`/` is the searchable public homepage. `/catalog` returns the same published-only tool catalog as JSON.

Tool docs routes support both people and agents:

- Browser requests to `/tools/<slug>/docs` render a human-readable docs page.
- Agent/script requests receive JSON by default.
- Add `?format=json` to force the agent JSON response from a browser.
- Add `?format=html` to force the human-readable page.

Agent discovery and hosted access:

- `/llms.txt` gives agents a compact discovery file.
- `/llms-full.txt` includes the full published tool list and JSON-RPC example.
- `/openapi.json` describes the HTTP API.
- `/mcp` exposes an MCP-compatible JSON-RPC endpoint with methods: `initialize`, `tools/list`, `tools/call`, `resources/list`, and `resources/read`. This is hosted agent access, not full streamable HTTP/SSE MCP transport.

Full tool IDs work when URL-encoded:

```bash
curl "http://localhost:8787/tools/%2Fgtm%2Fhubspot/docs?topic=contacts"
```

The hosted API uses the same routes:

```bash
curl "https://gtm-docs-registry.vercel.app/tools/resolve?query=hubspot"
curl "https://gtm-docs-registry.vercel.app/tools/hubspot/docs?topic=contacts"
```

Vercel deployment is configured through `api/index.js` and `vercel.json`.

## Data Model

Each tool profile has three required files and may include one optional reference file.

`tool.json` contains canonical machine-readable metadata:

```json
{
  "id": "/gtm/hubspot",
  "name": "HubSpot",
  "slug": "hubspot",
  "status": "published",
  "aliases": ["hubspot crm", "hs"],
  "agentReadinessScore": 5,
  "lastVerified": "2026-05-28",
  "interfaces": {
    "officialMcp": "yes",
    "officialCli": "yes",
    "officialApi": "yes",
    "openApi": "yes",
    "llmsTxt": "yes",
    "officialSdk": "yes"
  },
  "sourceQuality": {
    "official": "strong",
    "community": "medium"
  }
}
```

`docs.md` is the agent-facing profile. It should include:

- Summary of what the tool is.
- Agent interface availability.
- Auth model, permissions, key objects, key actions, pagination, rate limits, webhooks, destructive operations, and caveats.
- Source links used to build the profile.

`reference.md` is optional. Use it for denser retrieval material that would make `docs.md` noisy:

- Canonical endpoint tables.
- Object schemas and required fields.
- Auth flows and scope matrices.
- Pagination and rate-limit tables.
- Destructive operation notes.

`sources.json` records source metadata:

- `lastVerified`.
- Official documentation, API, MCP, CLI, SDK, changelog, and spec URLs where available.
- Community sources when useful, clearly separated from official sources.

`registry.json` indexes every tool:

- `id`, `name`, `slug`, `status`, `path`, `aliases`, `agentReadinessScore`, and `lastVerified`.

## Status And Readiness

Profile status values:

- `published`: usable by agents, source-backed, and validated.
- `needs-review`: structurally valid, but has an unresolved research question, weak source coverage, or a confidence issue.
- `draft`: incomplete and not ready for agent use.
- `monitoring`: published profile that should be watched for known upcoming changes.

`agentReadinessScore` is a 1-5 signal for how directly an agent can operate against the tool:

- `5`: strong official agent surface, API, specs, SDKs, or clear operational docs.
- `4`: good official API/docs with minor gaps.
- `3`: usable but requires more interpretation or source stitching.
- `2`: weak official support; community or wrapper evidence may be needed.
- `1`: minimal agent-operable surface.

Scores are not product rankings. They describe documentation and interface readiness for agents.

## Contributing

To add or update a tool:

1. Create or edit `tools/<slug>/tool.json`.
2. Create or edit `tools/<slug>/docs.md`.
3. Optionally create or edit `tools/<slug>/reference.md` for dense endpoint/object/schema details.
4. Create or edit `tools/<slug>/sources.json`.
5. Add or update the matching entry in `registry.json`.
6. Run validation:

```bash
npm run validate
npm run eval
npm run reports
```

Research in this order:

1. Official MCP docs.
2. Official CLI docs.
3. Official API docs.
4. Official OpenAPI/spec docs.
5. Official llms.txt or AI-agent docs.
6. Official SDKs or GitHub repositories.
7. Strong community MCP, CLI, SDK, or integration sources.
8. Wrapper docs such as Zapier, Make, Pipedream, or similar.

Prefer official sources. Mark community sources as unofficial. Do not invent capabilities, categories, rankings, or recipes. If something is unclear, mark the profile `needs-review` and include the exact question to resolve.

## Freshness Philosophy

GTM Docs Registry is maintained as a source-backed retrieval layer, not a static blog post.

Profiles should be refreshed when:

- A tool launches or changes MCP, CLI, API, OpenAPI/spec, llms.txt, or SDK support.
- Auth, rate limits, permissions, pagination, object models, or destructive operations change.
- Official docs move, disappear, or contradict older profile notes.
- Community sources become obsolete or are replaced by official support.

Freshness is recorded with `lastVerified` dates in both the registry and per-tool source metadata. Stale or uncertain profiles should remain available when structurally valid, but must be marked honestly with status and caveats.

## Automation

Verify source health:

```bash
npm run verify:sources
```

Detect possible metadata drift:

```bash
npm run detect:drift
```

`verify:sources` checks source URLs with HEAD plus GET fallback. Its default mode is CI-safe; use `node scripts/verify-sources.js --strict` when any source problem should fail locally.

`detect:drift` reports profiles where source evidence mentions MCP, OpenAPI, llms.txt, SDK, CLI, or API surfaces while metadata still says `unknown` or `no`. It only reports; it does not edit profiles.

Create a review-only draft profile:

```bash
npm run draft -- examples/draft-profile-input.json
```

Drafts are written under `draft-profiles/<slug>/`, ignored by git, and never added to `registry.json` automatically.

## Non-Goals

- No workflow recipes.
- No buying comparison marketplace.
- No rankings or buying recommendations.
- No unsupported claims.
- No category taxonomy unless it is source-backed and useful for retrieval.

GTM Docs Registry helps agents retrieve the right GTM tool documentation. The agent decides what workflow to build from that context.
