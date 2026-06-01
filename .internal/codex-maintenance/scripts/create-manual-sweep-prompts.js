#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const options = parseArgs(process.argv.slice(2));
const runDir = path.join(root, options.runDir);
const manifest = readJson(path.join(runDir, "manifest.json"));
const promptsDir = path.join(runDir, "operator-prompts");

fs.mkdirSync(promptsDir, { recursive: true });

for (const batch of manifest.batches || []) {
  const inputPath = path.join(runDir, "scout-inputs", `${batch.batchId}.json`);
  const input = readJson(inputPath);
  const prompt = renderPrompt({ manifest, batch, input, runDir: options.runDir });
  fs.writeFileSync(path.join(promptsDir, `${batch.batchId}.md`), `${prompt.trimEnd()}\n`);
}

fs.writeFileSync(path.join(promptsDir, "INDEX.md"), `${renderIndex(manifest, options.runDir).trimEnd()}\n`);

console.log(`Wrote ${manifest.batchCount} manual batch prompts to ${path.relative(root, promptsDir)}`);

function parseArgs(args) {
  const parsed = { runDir: "" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--run-dir") parsed.runDir = args[++index] || "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!parsed.runDir) throw new Error("--run-dir is required");
  return parsed;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function renderIndex(manifest, runDir) {
  const rows = (manifest.batches || []).map((batch) => {
    return `| ${batch.batchId} | ${batch.toolCount} | \`${runDir}/operator-prompts/${batch.batchId}.md\` |`;
  });

  return [
    `# Manual Sweep Prompts: ${manifest.runId}`,
    "",
    `Run directory: \`${runDir}\``,
    `Tools: ${manifest.toolCount}`,
    `Batches: ${manifest.batchCount}`,
    `Max agents per batch: ${manifest.maxAgentsPerSwarm}`,
    "",
    "| Batch | Tools | Prompt |",
    "| --- | ---: | --- |",
    ...rows,
    "",
  ].join("\n");
}

function renderPrompt({ manifest, batch, input, runDir }) {
  const toolsList = input.tools
    .map((tool) => `- ${tool.name} (${tool.id}) in \`${tool.path}\``)
    .join("\n");

  return `# ${manifest.runId} ${batch.batchId}

You are running one bounded GTM Docs Registry maintenance batch.

Repository: Andytoizer/gtm-docs-registry
Run directory: \`${runDir}\`
Batch input: \`${runDir}/scout-inputs/${batch.batchId}.json\`

Assigned tools:

${toolsList}

Operating model:

- Use 3 independent scout passes across these tools.
- Use 3 independent QA passes to skeptically review the scout findings.
- Memory may guide where to look, but memory is not evidence.
- Require current source URLs for claims.
- Prefer official docs, official GitHub, official help centers, official changelogs, and official specs.
- Treat community MCP/CLI/API wrappers as community evidence only.
- Do not edit registry/tool files directly from this batch thread.
- Write structured JSON artifacts only.

Required outputs:

\`\`\`text
${runDir}/scout-findings/${batch.batchId}.json
${runDir}/qa-verdicts/${batch.batchId}.json
\`\`\`

Scout output must match \`.internal/codex-maintenance/schemas/scout-finding.schema.json\`.
QA output must match \`.internal/codex-maintenance/schemas/qa-verdict.schema.json\`.

Final answer:

- State the six tools checked.
- State approved, rejected, and needs-human-review findings.
- State the exact artifact files written.
- Do not commit, push, or apply changes in this batch thread. Consolidation happens after all batches finish.
`;
}

