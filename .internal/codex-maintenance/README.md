# Internal Codex Maintenance

This folder is intentionally hidden from the public-facing registry instructions.

The actual product surfaces are the CLI, MCP server, HTTP API, catalog, `registry.json`, and `tools/*` profiles. This folder exists only for the scheduled Codex cloud maintenance job that keeps the registry fresh.

## Run Protocol

Use these scripts from the repository root:

```bash
node .internal/codex-maintenance/scripts/create-maintenance-plan.js --run-id "$(date -u +%F)" --batch-size 10 --max-agents 6
node .internal/codex-maintenance/scripts/run-scout-batch.js --run-dir ".internal/codex-maintenance/runs/<run-id>" --batch-id scout-001
node .internal/codex-maintenance/scripts/run-qa-batch.js --run-dir ".internal/codex-maintenance/runs/<run-id>" --batch-id scout-001
node .internal/codex-maintenance/scripts/apply-approved-findings.js --run-dir ".internal/codex-maintenance/runs/<run-id>"
node .internal/codex-maintenance/scripts/render-maintenance-report.js --run-dir ".internal/codex-maintenance/runs/<run-id>"
```

Memory may guide where scouts search, but memory is not evidence. Scout findings must cite current sources, and QA must approve findings before they are applied or used in a registry update.

## Manual Full-Sweep Day

Use this when Andy has the computer open and wants one same-day sweep across the full registry.

The safe unit of work is one six-tool batch:

```text
1 batch = 6 tools
1 batch swarm = 3 scout passes + 3 QA passes
196 tools = 33 batches
```

Do not try to make one thread review all 196 tools. Create the plan once, then launch batches in parallel waves.

Recommended same-day shape:

```text
Wave 1: scout-001 through scout-008
Wave 2: scout-009 through scout-016
Wave 3: scout-017 through scout-024
Wave 4: scout-025 through scout-033
Consolidation: apply approved findings, regenerate reports, validate, commit, push PR branch
```

Generate the batch plan and copy-ready prompts:

```bash
RUN_ID="$(date -u +%F)"
node .internal/codex-maintenance/scripts/create-maintenance-plan.js --run-id "$RUN_ID" --batch-size 6 --max-agents 6
node .internal/codex-maintenance/scripts/create-manual-sweep-prompts.js --run-dir ".internal/codex-maintenance/runs/$RUN_ID"
```

Open the generated prompts under:

```text
.internal/codex-maintenance/runs/<run-id>/operator-prompts/
```

For each batch prompt, launch a separate Codex thread or sub-agent. Each batch must write:

```text
.internal/codex-maintenance/runs/<run-id>/scout-findings/<batch-id>.json
.internal/codex-maintenance/runs/<run-id>/qa-verdicts/<batch-id>.json
```

After every batch returns, run the consolidation:

```bash
node .internal/codex-maintenance/scripts/apply-approved-findings.js --run-dir ".internal/codex-maintenance/runs/<run-id>"
node .internal/codex-maintenance/scripts/render-maintenance-report.js --run-dir ".internal/codex-maintenance/runs/<run-id>"
npm run validate
npm run eval
npm run reports
npm run detect:drift
git switch -c "codex/weekly-maintenance-<run-id>"
git add registry.json tools reports ".internal/codex-maintenance/runs/<run-id>"
git commit -m "Add <run-id> maintenance sweep"
git push origin "codex/weekly-maintenance-<run-id>"
```

The final consolidation thread must not finish with only dirty files in a hidden worktree. It must commit and push a review branch, or explicitly state why it could not.
