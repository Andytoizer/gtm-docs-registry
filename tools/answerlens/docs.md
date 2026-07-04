# AnswerLens

## Agent Summary

AnswerLens is a public evidence audit tool for B2B SaaS websites. Its public pages describe free evidence reports, a $79 paid report, use-case pages for AI search and answer-engine readiness, and an agency intake checklist for checking public proof before scoping client work.

Agent readiness score: 2/5.

## Available Surfaces

- Official MCP: no
- Official CLI: no
- Official API: no
- OpenAPI/spec: no
- llms/AI docs: yes
- Official SDK: no
- Community MCP: unknown
- Community CLI: unknown
- Community SDK / integration: unknown

## Auth

No public API, MCP, CLI, SDK, or automation auth is documented. The public `llms.txt` says admin, report detail, and API routes are private or restricted. Use public pages, the sitemap, and `llms.txt` for retrieval. Do not assume private report or admin routes are available to agents.

## Main Objects

- Free public evidence reports
- Paid evidence reports
- Use-case pages
- Campaign pages
- SaaS client-intake checklist
- Public `llms.txt`

## Rate Limits

No public API rate limits are documented. The public `llms.txt` tells crawlers to use the homepage and sitemap only.

## Pagination

No public list, report, or object API pagination is documented.

## Agent Caveats

- Destructive action risk: low.
- Treat AnswerLens as a public retrieval profile, not an automation API profile.
- Do not infer access to report detail, admin, or API routes from public marketing pages.
- Verify the current paid-report workflow from public pricing and policy pages before using commercial details in downstream agents.
- Prefer `https://app.sfdj.net/llms.txt`, the sitemap, and linked public use-case/resource pages for retrieval.

## Needs Human Review

Keep needs-review: official `llms.txt` and public product pages are available, but no public MCP, CLI, API, OpenAPI, or SDK docs were found.

## Sources

- https://app.sfdj.net/
- https://app.sfdj.net/llms.txt
- https://app.sfdj.net/pricing
- https://app.sfdj.net/contact
- https://app.sfdj.net/use-cases/answer-engine-readiness-audit
- https://app.sfdj.net/use-cases/llm-visibility-audit
- https://app.sfdj.net/use-cases/ai-citation-readiness-audit
- https://app.sfdj.net/resources/saas-client-intake-evidence-checklist
