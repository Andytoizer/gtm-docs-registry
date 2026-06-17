# Google Sheets

## Agent Summary

Google Sheets lets agents create spreadsheets, read and write cell values, update formatting, manage sheets/tabs, work with developer metadata, and automate common spreadsheet operations through the official Sheets API, Google client libraries, Discovery metadata, and the Google Workspace CLI. Check auth scopes, quota limits, range chunking, and high write risk before using Google Sheets in automations.

Agent readiness score: 4/5.

## Available Surfaces

- Official MCP: no
- Official CLI: yes
- Official API: yes
- OpenAPI/spec: no
- llms/AI docs: unknown
- Official SDK: yes
- Community MCP: yes
- Community CLI: yes
- Community SDK / integration: yes

## Auth

OAuth 2.0 scopes include `https://www.googleapis.com/auth/spreadsheets`, `https://www.googleapis.com/auth/drive`, and `https://www.googleapis.com/auth/drive.file`. Sheets scopes apply to an entire spreadsheet file, not to a single sheet/tab, so agents should use the narrowest viable scope and ProtectedRange controls where sheet-level modification needs guardrails. Service accounts must be granted access to target spreadsheets directly or through Workspace domain-wide delegation.

## Main Objects

- Spreadsheets
- sheets
- cells
- ranges
- values
- ValueRange
- developer metadata
- named ranges
- protected ranges
- filters
- charts
- pivot tables
- conditional formatting
- tables
- data sources

## Rate Limits

Read and write requests are each limited to 300 requests per minute per project and 60 requests per minute per user per project. Google recommends keeping payloads at or below 2 MB where possible and using truncated exponential backoff for `429` quota errors. Requests that process longer than 180 seconds can time out.

## Pagination

Google Sheets is mostly range/DataFilter based rather than cursor based. Use A1 notation, `spreadsheets.values.batchGet`, `spreadsheets.values.batchUpdate`, and DataFilters to chunk large reads and writes. Batch update operations are atomic: if one request is invalid, none of the grouped changes are applied.

## Agent Caveats

- Destructive action risk: high.
- The official Google Workspace remote MCP preview currently lists Gmail, Drive, Calendar, Chat, and People servers, not a dedicated Sheets remote MCP server.
- Google Workspace Developer Tools provides an official docs-focused MCP server for retrieving Workspace API docs and snippets, but it is not a Sheets data-action MCP.
- The Google Workspace CLI covers Sheets and is useful for agent workflows, but its README says it is not an officially supported Google product.
- Use Drive APIs or Drive MCP for spreadsheet file discovery, permissions, ownership, revisions, and export/download; use Sheets API for spreadsheet content and structure.
- Sheet writes can overwrite formulas, clear ranges, delete tabs, change formatting, or affect collaborators. Prefer append/update scopes, explicit A1 ranges, dry-run previews, and narrow OAuth scopes.
- Connected Sheets and data-source operations can require additional scopes such as BigQuery read-only access.
- Prefer official Sheets API docs and Google client libraries first. Use community MCP/CLI/SDK sources only when clearly marked unofficial.

## Sources

- https://developers.google.com/workspace/sheets/api/guides/concepts
- https://developers.google.com/workspace/sheets/api/reference/rest
- https://developers.google.com/workspace/sheets/api/limits
- https://developers.google.com/workspace/sheets/api/scopes
- https://developers.google.com/workspace/sheets/api/guides/batch
- https://developers.google.com/workspace/sheets/api/guides/values
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/clear
- https://developers.google.com/workspace/sheets/api/samples/sheet
- https://developers.google.com/workspace/sheets/api/samples/rowcolumn
- https://developers.google.com/workspace/guides/developer-tools
- https://developers.google.com/workspace/guides/configure-mcp-servers
- https://github.com/googleworkspace/cli
- https://github.com/google/mcp
