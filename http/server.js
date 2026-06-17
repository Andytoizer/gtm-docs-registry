#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatDocsResult,
  formatFullDocsResult,
  loadToolFiles,
  parseSources,
  resolveTool,
  retrieveDocs,
  searchTools
} from "../lib/retrieval.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const registry = JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8"));
const port = Number.parseInt(process.env.PORT || "8787", 10);
const publishedTools = registry.tools.filter((tool) => tool.status === "published");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function sendError(res, statusCode, message, details) {
  sendJson(res, statusCode, {
    error: {
      message,
      ...(details ? { details } : {})
    }
  });
}

function sendHtml(res, html) {
  res.writeHead(200, {
    ...CORS_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    "Content-Length": Buffer.byteLength(html)
  });
  res.end(html);
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=300",
    "Content-Length": Buffer.byteLength(text),
    ...extraHeaders
  });
  res.end(text);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function parseLimit(value, fallback = 10, max = 25) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.min(parsed, max);
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function toolFromPath(segments, terminalSegment) {
  const terminalIndex = segments.lastIndexOf(terminalSegment);
  if (segments[0] !== "tools" || terminalIndex < 2) return null;
  return segments.slice(1, terminalIndex).map(decodeSegment).join("/");
}

function publicTool(tool) {
  return {
    id: tool.id,
    name: tool.name,
    slug: tool.slug,
    status: tool.status,
    path: tool.path,
    aliases: tool.aliases || [],
    agentReadinessScore: tool.agentReadinessScore,
    lastVerified: tool.lastVerified
  };
}

function homeTool(tool) {
  const toolRoot = path.join(root, tool.path);
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(toolRoot, "tool.json"), "utf8"));
  } catch {
    meta = {};
  }
  const surfaces = meta.surfaces || meta.interfaces || {};
  return {
    id: tool.id,
    name: tool.name,
    slug: tool.slug,
    aliases: tool.aliases || [],
    score: tool.agentReadinessScore,
    lastVerified: tool.lastVerified,
    canonicalUrl: meta.canonicalUrl || "",
    surfaces: {
      mcp: normalizeSurface(surfaces.officialMcp),
      api: normalizeSurface(surfaces.officialApi),
      cli: normalizeSurface(surfaces.officialCli),
      openapi: normalizeSurface(surfaces.openApiSpec || surfaces.openApi),
      llms: normalizeSurface(surfaces.llmsDocs || surfaces.llmsTxt),
      sdk: normalizeSurface(surfaces.officialSdk)
    }
  };
}

function normalizeSurface(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return String(value || "unknown").toLowerCase();
}

function handleHome(res) {
  sendHtml(res, renderHomepage());
}

function handleLlms(res, full = false) {
  sendText(res, 200, renderLlmsTxt({ full }));
}

function handleOpenApi(res) {
  sendJson(res, 200, buildOpenApiSpec());
}

function handleHealth(res) {
  sendJson(res, 200, {
    ok: true,
    service: "gtm-docs-registry-http",
    registryUpdatedAt: registry.updatedAt,
    toolCount: registry.tools.length
  });
}

function handleRegistry(res) {
  sendJson(res, 200, registry);
}

function handleCatalog(res) {
  sendJson(res, 200, {
    count: publishedTools.length,
    tools: publishedTools.map(homeTool)
  });
}

function handleMcpInfo(res) {
  sendJson(res, 200, {
    name: "gtm-docs-registry",
    description: "MCP-compatible JSON-RPC endpoint exposing GTM Docs Registry retrieval tools. This is not streamable HTTP/SSE MCP transport.",
    endpoint: "/mcp",
    transport: "http-json-rpc",
    protocol: "modelcontextprotocol-compatible",
    methods: ["initialize", "tools/list", "tools/call", "resources/list", "resources/read"],
    tools: mcpToolDefinitions().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  });
}

function wantsJson(req, reqUrl) {
  const format = String(reqUrl.searchParams.get("format") || "").toLowerCase();
  if (format === "json") return true;
  if (format === "html") return false;
  const accept = String(req.headers.accept || "");
  return !accept.includes("text/html");
}

function handleSearch(reqUrl, res) {
  const query = String(reqUrl.searchParams.get("q") || "").trim();
  if (!query) {
    sendError(res, 400, "Missing required query parameter: q");
    return;
  }

  const limit = parseLimit(reqUrl.searchParams.get("limit"));
  if (limit === null) {
    sendError(res, 400, "Invalid limit. Use an integer from 1 to 25.");
    return;
  }

  const results = searchTools({ root, registry, query, limit }).map(({ tool, score }) => ({
    tool: publicTool(tool),
    score: Number(score.toFixed(2))
  }));

  sendJson(res, 200, {
    query,
    limit,
    count: results.length,
    results
  });
}

function handleResolve(reqUrl, res) {
  const query = String(reqUrl.searchParams.get("query") || "").trim();
  if (!query) {
    sendError(res, 400, "Missing required query parameter: query");
    return;
  }

  const tool = resolveTool(registry, query);
  if (!tool) {
    sendError(res, 404, `No tool found for: ${query}`);
    return;
  }

  sendJson(res, 200, {
    query,
    tool: publicTool(tool)
  });
}

function handleDocs(req, reqUrl, res, slugOrId) {
  if (!slugOrId) {
    sendError(res, 400, "Missing tool slug or ID.");
    return;
  }

  const tool = resolveTool(registry, slugOrId);
  if (!tool) {
    sendError(res, 404, `No tool found for: ${slugOrId}`);
    return;
  }

  const topic = String(reqUrl.searchParams.get("topic") || "").trim();
  const files = loadToolFiles(root, tool);
  const sources = parseSources(files.sourcesText);

  if (!topic) {
    if (!wantsJson(req, reqUrl)) {
      sendHtml(res, renderToolDocsPage({ tool, files, sources, topic: null }));
      return;
    }

    sendJson(res, 200, docsPayload(tool, files));
    return;
  }

  const result = retrieveDocs({ ...files, topic });
  if (!wantsJson(req, reqUrl)) {
    sendHtml(res, renderToolDocsPage({ tool, files, sources, topic, result }));
    return;
  }

  sendJson(res, 200, docsPayload(tool, files, topic));
}

function handleSources(res, slugOrId) {
  if (!slugOrId) {
    sendError(res, 400, "Missing tool slug or ID.");
    return;
  }

  const tool = resolveTool(registry, slugOrId);
  if (!tool) {
    sendError(res, 404, `No tool found for: ${slugOrId}`);
    return;
  }

  const { sourcesText } = loadToolFiles(root, tool);
  sendJson(res, 200, {
    tool: publicTool(tool),
    sources: parseSources(sourcesText)
  });
}

function docsPayload(tool, files, topic = "") {
  const sources = parseSources(files.sourcesText);
  if (!topic) {
    return {
      tool: publicTool(tool),
      topic: null,
      text: formatFullDocsResult(files),
      hasReference: files.hasReference,
      sources
    };
  }

  const result = retrieveDocs({ ...files, topic });
  return {
    tool: publicTool(tool),
    topic,
    hasReference: files.hasReference,
    text: formatDocsResult(result),
    sections: result.selected,
    fallback: result.fallback,
    sources: result.relatedSources
  };
}

function mcpToolDefinitions() {
  return [
    {
      name: "resolve-tool-id",
      description: "Resolve a GTM product name, slug, alias, or /gtm/<slug> ID to registry metadata.",
      inputSchema: {
        type: "object",
        properties: {
          toolName: { type: "string", description: "Tool name, alias, slug, or /gtm/<slug> ID." }
        },
        required: ["toolName"],
        additionalProperties: false
      }
    },
    {
      name: "get-tool-docs",
      description: "Get source-backed retrieval docs for a GTM tool, optionally filtered by topic.",
      inputSchema: {
        type: "object",
        properties: {
          toolId: { type: "string", description: "Tool name, slug, alias, or /gtm/<slug> ID." },
          topic: { type: "string", description: "Optional retrieval topic such as auth, MCP, pagination, contacts API." }
        },
        required: ["toolId"],
        additionalProperties: false
      }
    },
    {
      name: "get-tool-sources",
      description: "Get source metadata for a GTM tool.",
      inputSchema: {
        type: "object",
        properties: {
          toolId: { type: "string", description: "Tool name, slug, alias, or /gtm/<slug> ID." }
        },
        required: ["toolId"],
        additionalProperties: false
      }
    },
    {
      name: "search-tools",
      description: "Search GTM tool names, aliases, and docs text for ranked matches.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: { type: "integer", minimum: 1, maximum: 25, default: 10 }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  ];
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function handleMcpPost(req, res) {
  let message;
  try {
    const body = await readRequestBody(req);
    message = JSON.parse(body || "{}");
  } catch {
    sendJson(res, 400, mcpError(null, -32700, "Parse error"));
    return;
  }

  if (Array.isArray(message)) {
    sendJson(res, 200, message.map((entry) => handleMcpMessage(entry)).filter(Boolean));
    return;
  }

  const response = handleMcpMessage(message);
  if (!response) {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

function handleMcpMessage(message) {
  const id = Object.prototype.hasOwnProperty.call(message || {}, "id") ? message.id : null;
  const method = message?.method;
  const params = message?.params || {};

  if (!id && String(method || "").startsWith("notifications/")) return null;

  try {
    if (method === "initialize") {
      return mcpResult(id, {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: {
          tools: {},
          resources: {}
        },
        serverInfo: {
          name: "gtm-docs-registry",
          version: "0.1.0"
        }
      });
    }

    if (method === "tools/list") {
      return mcpResult(id, { tools: mcpToolDefinitions() });
    }

    if (method === "tools/call") {
      return mcpResult(id, callMcpTool(params.name, params.arguments || {}));
    }

    if (method === "resources/list") {
      return mcpResult(id, {
        resources: [
          { uri: "gtm://registry", name: "GTM Tool Registry", mimeType: "application/json" },
          ...publishedTools.flatMap((tool) => [
            { uri: `gtm://tool/${tool.slug}/docs`, name: `${tool.name} docs`, mimeType: "text/markdown" },
            { uri: `gtm://tool/${tool.slug}/sources`, name: `${tool.name} sources`, mimeType: "application/json" }
          ])
        ]
      });
    }

    if (method === "resources/read") {
      return mcpResult(id, readMcpResource(params.uri));
    }

    return mcpError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    return mcpError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

function mcpResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function mcpError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function callMcpTool(name, args) {
  if (name === "resolve-tool-id") {
    const query = String(args.toolName || "").trim();
    const tool = resolveTool(registry, query);
    if (!tool) return mcpText(`No tool found for ${query}`, true);
    return mcpText(JSON.stringify(publicTool(tool), null, 2));
  }

  if (name === "get-tool-docs") {
    const query = String(args.toolId || "").trim();
    const tool = resolveTool(registry, query);
    if (!tool) return mcpText(`No tool found for ${query}`, true);
    const files = loadToolFiles(root, tool);
    const topic = String(args.topic || "").trim();
    const payload = docsPayload(tool, files, topic);
    return mcpText(payload.text);
  }

  if (name === "get-tool-sources") {
    const query = String(args.toolId || "").trim();
    const tool = resolveTool(registry, query);
    if (!tool) return mcpText(`No tool found for ${query}`, true);
    const { sourcesText } = loadToolFiles(root, tool);
    return mcpText(sourcesText);
  }

  if (name === "search-tools") {
    const query = String(args.query || "").trim();
    const limit = Math.min(Math.max(Number.parseInt(args.limit || "10", 10) || 10, 1), 25);
    const results = searchTools({ root, registry, query, limit });
    const text = results.length
      ? results.map(({ tool, score }) => `${tool.id}\t${tool.name}\tscore=${score.toFixed(1)}`).join("\n")
      : `No tools found for ${query}`;
    return mcpText(text);
  }

  return mcpText(`Unknown tool: ${name}`, true);
}

function mcpText(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {})
  };
}

function readMcpResource(uri) {
  if (uri === "gtm://registry") {
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(registry, null, 2) }]
    };
  }

  const match = /^gtm:\/\/tool\/(.+?)\/(docs|sources)$/.exec(String(uri || ""));
  if (!match) return { contents: [{ uri, mimeType: "text/plain", text: `Unknown resource: ${uri}` }] };

  const tool = resolveTool(registry, match[1]);
  if (!tool) return { contents: [{ uri, mimeType: "text/plain", text: `No tool found for ${match[1]}` }] };

  const files = loadToolFiles(root, tool);
  if (match[2] === "sources") {
    return { contents: [{ uri, mimeType: "application/json", text: files.sourcesText }] };
  }

  return {
    contents: [{ uri, mimeType: "text/markdown", text: formatFullDocsResult({ ...files, includeSources: false }) }]
  };
}

function renderLlmsTxt({ full = false } = {}) {
  const baseUrl = "https://gtm-docs-registry.vercel.app";
  const topTools = publishedTools.slice(0, full ? publishedTools.length : 40);
  const lines = [
    "# GTM Docs Registry",
    "",
    "Source-backed docs retrieval for GTM tools. Use this service to resolve GTM product names and fetch agent-ready documentation about MCP, CLI, API, OpenAPI, SDK, auth, pagination, rate limits, webhooks, destructive operations, and source links.",
    "",
    "This is not a buying guide or workflow recipe catalog. Agents should use it as a retrieval layer and compose their own workflows from returned source-backed documentation.",
    "",
    "## Agent Endpoints",
    "",
    `- Homepage and searchable catalog: ${baseUrl}/`,
    `- Published catalog JSON: ${baseUrl}/catalog`,
    `- OpenAPI spec: ${baseUrl}/openapi.json`,
    `- MCP-compatible JSON-RPC endpoint: ${baseUrl}/mcp`,
    `- Registry JSON: ${baseUrl}/registry`,
    `- Search tools: ${baseUrl}/tools/search?q=hubspot&limit=5`,
    `- Resolve tool: ${baseUrl}/tools/resolve?query=hubspot`,
    `- Human docs page: ${baseUrl}/tools/hubspot/docs`,
    `- Agent JSON docs: ${baseUrl}/tools/hubspot/docs?format=json`,
    `- Topic retrieval JSON: ${baseUrl}/tools/hubspot/docs?topic=contacts&format=json`,
    `- Source metadata: ${baseUrl}/tools/hubspot/sources`,
    "",
    "## MCP-Compatible JSON-RPC Tools",
    "",
    "- resolve-tool-id: resolve a GTM product name or alias to a /gtm/<slug> ID.",
    "- get-tool-docs: retrieve source-backed tool docs, optionally filtered by topic.",
    "- get-tool-sources: retrieve source metadata for a tool.",
    "- search-tools: search names, aliases, and docs text.",
    "",
    "## Recommended Agent Flow",
    "",
    "1. Call /tools/resolve?query=<name> or MCP resolve-tool-id.",
    "2. Call /tools/<slug>/docs?topic=<topic>&format=json or MCP get-tool-docs.",
    "3. Inspect returned sources before destructive or high-impact actions.",
    "4. Prefer official MCP/API/CLI/OpenAPI/SDK surfaces when present.",
    "",
    `## Published Tools (${publishedTools.length})`,
    "",
    ...topTools.map((tool) => `- ${tool.name}: ${baseUrl}/tools/${tool.slug}/docs?format=json`)
  ];

  if (!full) {
    lines.push("", `For the complete ${publishedTools.length}-tool list, fetch ${baseUrl}/llms-full.txt or ${baseUrl}/catalog.`);
  }

  if (full) {
    lines.push(
      "",
      "## Full Catalog JSON Shape",
      "",
      "/catalog returns { count, tools[] }. Each tool includes id, name, slug, aliases, score, lastVerified, canonicalUrl, and normalized surface flags for mcp, api, cli, openapi, llms, and sdk.",
      "",
      "## JSON-RPC MCP Example",
      "",
      "POST /mcp",
      "",
      "```json",
      JSON.stringify(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get-tool-docs",
            arguments: { toolId: "hubspot", topic: "contacts auth" }
          }
        },
        null,
        2
      ),
      "```"
    );
  }

  return `${lines.join("\n")}\n`;
}

function buildOpenApiSpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "GTM Docs Registry API",
      version: "0.1.0",
      description: "Source-backed docs retrieval for GTM tools."
    },
    servers: [{ url: "https://gtm-docs-registry.vercel.app" }],
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          responses: { 200: { description: "Service health" } }
        }
      },
      "/catalog": {
        get: {
          summary: "Published tool catalog",
          responses: { 200: { description: "Published tools only" } }
        }
      },
      "/registry": {
        get: {
          summary: "Full registry",
          responses: { 200: { description: "All registry entries including non-published statuses" } }
        }
      },
      "/tools/search": {
        get: {
          summary: "Search tools",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 25, default: 10 } }
          ],
          responses: { 200: { description: "Ranked tool search results" }, 400: { description: "Invalid query" } }
        }
      },
      "/tools/resolve": {
        get: {
          summary: "Resolve a tool name or alias",
          parameters: [{ name: "query", in: "query", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Resolved tool" }, 404: { description: "Tool not found" } }
        }
      },
      "/tools/{tool}/docs": {
        get: {
          summary: "Get tool docs",
          parameters: [
            { name: "tool", in: "path", required: true, schema: { type: "string" } },
            { name: "topic", in: "query", required: false, schema: { type: "string" } },
            { name: "format", in: "query", required: false, schema: { type: "string", enum: ["json", "html"] } }
          ],
          responses: {
            200: {
              description: "Human-readable HTML or agent JSON docs depending on Accept header/format query"
            },
            404: { description: "Tool not found" }
          }
        }
      },
      "/tools/{tool}/sources": {
        get: {
          summary: "Get tool source metadata",
          parameters: [{ name: "tool", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Source metadata" }, 404: { description: "Tool not found" } }
        }
      },
      "/mcp": {
        get: {
          summary: "MCP-compatible JSON-RPC endpoint metadata",
          responses: { 200: { description: "Endpoint and tool metadata" } }
        },
        post: {
          summary: "MCP-compatible JSON-RPC endpoint",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object" }
              }
            }
          },
          responses: { 200: { description: "JSON-RPC response" }, 204: { description: "Notification accepted" } }
        }
      },
      "/llms.txt": {
        get: {
          summary: "Agent discovery file",
          responses: { 200: { description: "Short llms.txt" } }
        }
      },
      "/llms-full.txt": {
        get: {
          summary: "Full agent discovery file",
          responses: { 200: { description: "Full llms.txt with all published tools" } }
        }
      },
      "/openapi.json": {
        get: {
          summary: "OpenAPI specification",
          responses: { 200: { description: "OpenAPI 3.1 document" } }
        }
      }
    }
  };
}

function renderHomepage() {
  const tools = publishedTools.map(homeTool);
  const toolsJson = JSON.stringify(tools).replaceAll("<", "\\u003c");
  const mcpCount = tools.filter((tool) => tool.surfaces.mcp === "yes").length;
  const apiCount = tools.filter((tool) => tool.surfaces.api === "yes").length;
  const highReadyCount = tools.filter((tool) => tool.score >= 5).length;

  const featuredSlugs = [
    "hubspot",
    "salesforce",
    "instantly",
    "apollo",
    "heyreach",
    "jungler",
    "rb2b",
    "notion",
    "n8n",
    "builtwith",
    "pylon",
    "exa"
  ];
  const featuredLogos = {
    hubspot: { src: "/assets/logos/hubspot.svg", variant: "wordmark" },
    salesforce: { src: "/assets/logos/salesforce.svg", variant: "icon" },
    instantly: { src: "/assets/logos/instantly.svg", variant: "wordmark" },
    apollo: { src: "/assets/logos/apollo.svg", variant: "icon" },
    heyreach: { src: "/assets/logos/heyreach.svg", variant: "wordmark dark" },
    jungler: { src: "/assets/logos/jungler.svg", variant: "icon" },
    rb2b: { src: "/assets/logos/rb2b.svg", variant: "wordmark dark" },
    notion: { src: "/assets/logos/notion.svg", variant: "icon" },
    n8n: { src: "/assets/logos/n8n.svg", variant: "wordmark" },
    builtwith: { src: "/assets/logos/builtwith.svg", variant: "icon" },
    pylon: { src: "/assets/logos/pylon.svg", variant: "wordmark" },
    exa: { src: "/assets/logos/exa.svg", variant: "icon" }
  };
  const featured = featuredSlugs.map((slug) => tools.find((tool) => tool.slug === slug)).filter(Boolean);

  const featuredCardsHtml = featured.map((tool) => {
    const surfaceOrder = ["mcp", "api", "cli", "openapi", "llms", "sdk"];
    const surfaceRow = surfaceOrder.map((key) => {
      const v = tool.surfaces[key] || "no";
      const cls = v === "yes" ? "ok" : v === "announced" ? "soon" : "off";
      return `<span class="dot ${cls}" title="${surfaceLabel(key)}: ${v}"><span>${surfaceLabel(key)}</span></span>`;
    }).join("");
    const alias = (tool.aliases && tool.aliases[0]) || tool.id;
    const initial = (tool.name[0] || "·").toUpperCase();
    const logo = featuredLogos[tool.slug];
    const logoHtml = logo
      ? `<span class="logo ${escapeHtml(logo.variant)}" aria-hidden="true"><img src="${escapeHtml(logo.src)}" alt="" loading="lazy" decoding="async"></span>`
      : `<span class="logo fallback" aria-hidden="true">${escapeHtml(initial)}</span>`;
    return `
      <a class="card" href="/tools/${encodeURIComponent(tool.slug)}/docs">
        <div class="card-head">
          ${logoHtml}
          <span class="card-score">${escapeHtml(tool.score)}<i>/5</i></span>
        </div>
        <div class="card-name">${escapeHtml(tool.name)}</div>
        <div class="card-alias">${escapeHtml(alias)}</div>
        <div class="card-surfaces" aria-label="Surface coverage">${surfaceRow}</div>
        <div class="card-cta">View docs <i class="arr">→</i></div>
      </a>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GTM Docs Registry — Source-backed docs for agent builders</title>
  <meta name="description" content="A registry of ${tools.length} GTM tools with verified MCP, API, CLI, OpenAPI, SDK and llms.txt docs your agents can rely on.">
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-dark-32.png">
  <link rel="icon" type="image/png" sizes="192x192" href="/assets/logo-dark-192.png">
  <link rel="apple-touch-icon" href="/assets/apple-touch-icon-dark.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
  <style>
    :root {
      color-scheme: light;
      --bg: #FFFFFF;
      --bg-2: #FAFAF9;
      --bg-3: #F5F5F4;
      --ink: #0A0A0A;
      --ink-2: #262626;
      --ink-3: #404040;
      --muted: #737373;
      --muted-2: #A3A3A3;
      --rule: #E7E5E4;
      --rule-soft: #F0EFED;
      --accent: #10B981;
      --accent-deep: #059669;
      --accent-tint: #ECFDF5;
      --warn: #F59E0B;
      --warn-tint: #FFFBEB;
      --dark: #0A0A0A;
      --dark-2: #171717;
      --dark-3: #262626;
      --dark-text: #FAFAFA;
      --dark-muted: #A3A3A3;
      --radius: 10px;
      --radius-lg: 14px;
      --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
      --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
    }
    *, *::before, *::after { box-sizing: border-box; }
    html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    body {
      margin: 0;
      font-family: "Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
      color: var(--ink);
      background: var(--bg);
      line-height: 1.5;
      letter-spacing: -0.005em;
    }
    a { color: inherit; text-decoration: none; }
    ::selection { background: var(--ink); color: #fff; }
    .shell { width: min(1240px, calc(100% - 40px)); margin: 0 auto; }
    .mono { font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: "Geist Mono", monospace;
      font-size: 11.5px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 500;
    }
    .eyebrow .dot-led {
      width: 6px; height: 6px; border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 0 2px rgba(16, 185, 129, .18);
      animation: ledPulse 2.4s var(--ease-in-out) infinite;
    }
    @keyframes ledPulse {
      0%, 100% { box-shadow: 0 0 0 2px rgba(16, 185, 129, .18); }
      50%      { box-shadow: 0 0 0 5px rgba(16, 185, 129, .08); }
    }

    /* ── Header ─────────────────────────────────────────────── */
    header {
      position: sticky;
      top: 0;
      z-index: 30;
      background: rgba(255, 255, 255, 0.78);
      backdrop-filter: saturate(160%) blur(14px);
      -webkit-backdrop-filter: saturate(160%) blur(14px);
      border-bottom: 1px solid var(--rule);
    }
    .nav {
      min-height: 60px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      font-size: 15px;
      letter-spacing: -0.01em;
    }
    .brand-mark {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      display: block;
      flex-shrink: 0;
      object-fit: cover;
    }
    .nav-links {
      display: flex;
      align-items: center;
      gap: 26px;
      font-size: 13.5px;
      color: var(--ink-3);
    }
    .nav-link {
      transition: color 160ms var(--ease-out);
    }
    .nav-link:hover { color: var(--ink); }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      height: 34px;
      padding: 0 14px;
      border-radius: 8px;
      border: 1px solid var(--rule);
      background: #fff;
      color: var(--ink);
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: transform 160ms var(--ease-out), background 160ms var(--ease-out), border-color 160ms var(--ease-out), color 160ms var(--ease-out), box-shadow 200ms var(--ease-out);
    }
    .btn:hover { border-color: var(--ink-3); }
    .btn:active { transform: scale(0.97); }
    .btn.primary {
      background: var(--ink);
      color: #fff;
      border-color: var(--ink);
    }
    .btn.primary:hover { background: var(--ink-2); border-color: var(--ink-2); box-shadow: 0 6px 20px -8px rgba(10,10,10,.4); }
    .btn.accent {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .btn.accent:hover { background: var(--accent-deep); border-color: var(--accent-deep); box-shadow: 0 6px 20px -8px rgba(16, 185, 129, .55); }
    .btn .arr { display: inline-block; transition: transform 200ms var(--ease-out); }
    .btn:hover .arr { transform: translateX(3px); }
    .btn-lg { height: 42px; padding: 0 18px; font-size: 14px; border-radius: 10px; }

    /* ── Hero ───────────────────────────────────────────────── */
    .hero {
      position: relative;
      padding: 84px 0 64px;
      overflow: hidden;
    }
    .hero::before {
      content: "";
      position: absolute;
      inset: -40px -40px auto -40px;
      height: 360px;
      background: radial-gradient(900px 360px at 50% 0%, rgba(16, 185, 129, 0.10), transparent 70%);
      pointer-events: none;
    }
    .hero-grid {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
      gap: 56px;
      align-items: end;
    }
    .hero-text > *, .hero-search { opacity: 0; transform: translateY(10px); animation: rise 600ms var(--ease-out) forwards; }
    .hero-text .eyebrow { animation-delay: 40ms; }
    .hero-text h1 { animation-delay: 100ms; }
    .hero-text .sub { animation-delay: 180ms; }
    .hero-text .actions { animation-delay: 260ms; }
    .hero-search { animation-delay: 220ms; }

    h1 {
      margin: 18px 0 0;
      font-size: clamp(48px, 6vw, 76px);
      line-height: 1.02;
      letter-spacing: -0.035em;
      font-weight: 600;
    }
    h1 .grad {
      background: linear-gradient(105deg, var(--ink) 35%, var(--accent-deep) 65%, var(--accent) 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .sub {
      max-width: 540px;
      margin: 22px 0 0;
      color: var(--ink-3);
      font-size: 17px;
      line-height: 1.55;
    }
    .actions {
      display: flex;
      gap: 10px;
      margin-top: 28px;
      flex-wrap: wrap;
    }
    .hero-meta {
      display: flex;
      gap: 24px;
      margin-top: 28px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 13px;
    }
    .hero-meta strong { color: var(--ink); font-weight: 600; }
    .hero-meta .sep { color: var(--rule); }

    /* ── Search panel ───────────────────────────────────────── */
    .hero-search {
      background: var(--bg);
      border: 1px solid var(--rule);
      border-radius: 14px;
      padding: 8px;
      box-shadow: 0 1px 0 #fff inset, 0 30px 80px -40px rgba(10,10,10,.18);
      position: relative;
    }
    .search-row {
      position: relative;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 12px 0 14px;
      height: 52px;
      border-radius: 10px;
      background: var(--bg);
      border: 1px solid transparent;
      transition: border-color 160ms var(--ease-out), background 160ms var(--ease-out);
    }
    .hero-search:focus-within .search-row {
      background: var(--bg);
      border-color: transparent;
    }
    .hero-search:focus-within {
      border-color: var(--ink-3);
      box-shadow: 0 0 0 4px rgba(10, 10, 10, 0.05), 0 30px 80px -40px rgba(10,10,10,.22);
    }
    .search-row svg { color: var(--muted); flex-shrink: 0; }
    .search-row input {
      flex: 1;
      min-width: 0;
      border: 0;
      background: transparent;
      font: inherit;
      font-size: 15px;
      color: var(--ink);
      outline: none;
    }
    .search-row input::placeholder { color: var(--muted-2); }
    .kbd {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 7px;
      border-radius: 6px;
      background: var(--bg-2);
      border: 1px solid var(--rule);
      color: var(--muted);
      font-family: "Geist Mono", monospace;
      font-size: 11px;
      font-weight: 500;
    }
    .search-results {
      display: none;
      margin-top: 6px;
      padding: 8px;
      border-top: 1px solid var(--rule-soft);
    }
    .search-results[data-open="true"] { display: block; }
    .sr-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 14px;
      align-items: center;
      padding: 10px 12px;
      border-radius: 8px;
      transition: background 140ms var(--ease-out);
    }
    .sr-row:hover { background: var(--bg-2); }
    .sr-name { font-weight: 500; font-size: 14px; }
    .sr-meta { font-family: "Geist Mono", monospace; font-size: 11px; color: var(--muted); }
    .sr-score { font-family: "Geist Mono", monospace; font-size: 11.5px; color: var(--muted); }
    .sr-arr { color: var(--muted); }
    .sr-empty { padding: 16px; color: var(--muted); font-size: 14px; text-align: center; }
    .sr-more {
      display: block;
      text-align: center;
      padding: 10px;
      margin-top: 4px;
      border-top: 1px solid var(--rule-soft);
      color: var(--muted);
      font-size: 13px;
    }
    .sr-more:hover { color: var(--ink); }

    /* ── Logo / signal strip ────────────────────────────────── */
    .signal {
      border-top: 1px solid var(--rule);
      border-bottom: 1px solid var(--rule);
      background: var(--bg-2);
    }
    .signal-row {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 32px;
      align-items: center;
      padding: 20px 0;
    }
    .signal-label {
      font-family: "Geist Mono", monospace;
      font-size: 11.5px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .signal-marquee {
      overflow: hidden;
      position: relative;
      mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent);
    }
    .signal-track {
      display: flex;
      gap: 44px;
      width: max-content;
      animation: marquee 50s linear infinite;
    }
    .signal-track span {
      color: var(--ink-3);
      font-weight: 500;
      font-size: 16px;
      letter-spacing: -0.005em;
      white-space: nowrap;
    }
    @keyframes marquee {
      from { transform: translateX(0); }
      to   { transform: translateX(-50%); }
    }
    .signal:hover .signal-track { animation-play-state: paused; }

    /* ── Section heads ──────────────────────────────────────── */
    section.block {
      padding: 88px 0;
      border-bottom: 1px solid var(--rule);
    }
    section.block.tight { padding: 56px 0 72px; }
    section.block.no-rule { border-bottom: 0; }
    .sec-head {
      display: flex;
      justify-content: space-between;
      align-items: end;
      gap: 28px;
      margin-bottom: 36px;
    }
    .sec-head h2 {
      margin: 12px 0 0;
      font-size: clamp(28px, 3vw, 40px);
      line-height: 1.05;
      letter-spacing: -0.025em;
      font-weight: 600;
      max-width: 620px;
    }
    .sec-head p {
      margin: 14px 0 0;
      color: var(--muted);
      max-width: 520px;
      font-size: 15px;
    }
    .sec-head .right {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    /* ── Featured grid ─────────────────────────────────────── */
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: 0;
      background: var(--bg);
      border: 1px solid var(--rule);
      border-radius: var(--radius-lg);
      padding: 20px;
      transition: transform 200ms var(--ease-out), border-color 200ms var(--ease-out), box-shadow 200ms var(--ease-out);
      position: relative;
      overflow: hidden;
    }
    .card:hover {
      border-color: var(--ink);
      transform: translateY(-2px);
      box-shadow: 0 10px 24px -16px rgba(10,10,10,.18);
    }
    .card:active { transform: scale(0.99); }
    .card-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
    }
    .logo {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      background: #fff;
      border: 1px solid var(--rule);
      color: var(--ink);
      display: grid;
      place-items: center;
      overflow: hidden;
      padding: 6px;
      flex-shrink: 0;
      font-weight: 600;
      font-size: 15px;
      letter-spacing: 0;
    }
    .logo.wordmark {
      width: 82px;
      padding: 7px 9px;
    }
    .logo.dark {
      background: var(--ink);
      border-color: var(--ink);
    }
    .logo.fallback {
      background: var(--ink);
      border-color: var(--ink);
      color: #fff;
      padding: 0;
    }
    .logo img {
      display: block;
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }
    .card-score {
      font-family: "Geist Mono", monospace;
      font-weight: 500;
      font-size: 13px;
      color: var(--ink);
    }
    .card-score i { color: var(--muted); font-style: normal; }
    .card-name {
      font-size: 17px;
      font-weight: 600;
      letter-spacing: -0.01em;
      line-height: 1.2;
    }
    .card-alias {
      margin-top: 4px;
      font-family: "Geist Mono", monospace;
      font-size: 11.5px;
      color: var(--muted);
    }
    .card-surfaces {
      display: flex;
      gap: 5px;
      margin: 16px 0 14px;
    }
    .dot {
      flex: 1;
      height: 22px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      font-family: "Geist Mono", monospace;
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.04em;
      transition: transform 160ms var(--ease-out);
    }
    .dot.ok { background: var(--accent); color: #fff; }
    .dot.soon { background: var(--warn-tint); color: var(--warn); border: 1px solid #FDE68A; }
    .dot.off { background: var(--bg-3); color: var(--muted-2); }
    .dot span { line-height: 1; }
    .card-cta {
      margin-top: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: "Geist Mono", monospace;
      font-size: 12px;
      color: var(--ink);
      letter-spacing: 0.02em;
    }
    .card-cta .arr { transition: transform 200ms var(--ease-out); }
    .card:hover .card-cta .arr { transform: translateX(3px); color: var(--accent); }

    /* ── Catalog (full list) ────────────────────────────────── */
    .filter-row {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .filter-row input[type="search"] {
      flex: 1;
      min-width: 220px;
      height: 38px;
      border: 1px solid var(--rule);
      border-radius: 8px;
      padding: 0 12px 0 36px;
      background: var(--bg) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23737373' stroke-width='1.6' stroke-linecap='round'><circle cx='7' cy='7' r='5'/><path d='m11 11 3 3'/></svg>") no-repeat 12px center;
      background-size: 14px 14px;
      font: inherit;
      font-size: 14px;
      color: var(--ink);
      outline: none;
      transition: border-color 160ms var(--ease-out), box-shadow 200ms var(--ease-out);
    }
    .filter-row input[type="search"]:focus {
      border-color: var(--ink);
      box-shadow: 0 0 0 4px rgba(10,10,10,.05);
    }
    .filter-row .chip {
      height: 30px;
      padding: 0 10px;
      border-radius: 999px;
      border: 1px solid var(--rule);
      background: var(--bg);
      color: var(--ink-3);
      font-family: "Geist Mono", monospace;
      font-size: 11.5px;
      letter-spacing: 0.03em;
      cursor: pointer;
      transition: all 160ms var(--ease-out);
    }
    .filter-row .chip:hover { border-color: var(--ink-3); color: var(--ink); }
    .filter-row .chip:active { transform: scale(0.96); }
    .filter-row .chip[data-active="true"] {
      background: var(--ink);
      border-color: var(--ink);
      color: #fff;
    }

    .list {
      border-top: 1px solid var(--rule);
      border-bottom: 1px solid var(--rule);
    }
    .list-row {
      display: grid;
      grid-template-columns: minmax(200px, 1.3fr) minmax(200px, 1.4fr) minmax(70px, auto) 28px;
      gap: 24px;
      align-items: center;
      padding: 14px 4px;
      border-bottom: 1px solid var(--rule-soft);
      transition: background 140ms var(--ease-out);
      cursor: pointer;
    }
    .list-row:last-child { border-bottom: 0; }
    .list-row:hover { background: var(--bg-2); }
    .lr-name {
      font-size: 15px;
      font-weight: 500;
      letter-spacing: -0.01em;
    }
    .lr-id {
      margin-top: 2px;
      font-family: "Geist Mono", monospace;
      font-size: 11px;
      color: var(--muted);
    }
    .lr-surfaces {
      display: flex;
      gap: 5px;
    }
    .lr-surfaces .pill {
      padding: 3px 7px;
      border-radius: 4px;
      font-family: "Geist Mono", monospace;
      font-size: 10.5px;
      font-weight: 500;
      letter-spacing: 0.02em;
    }
    .lr-surfaces .pill.ok { background: var(--accent-tint); color: var(--accent-deep); }
    .lr-surfaces .pill.soon { background: var(--warn-tint); color: var(--warn); }
    .lr-score {
      font-family: "Geist Mono", monospace;
      font-size: 13px;
      color: var(--ink);
      font-weight: 500;
      text-align: right;
    }
    .lr-score i { color: var(--muted); font-style: normal; font-weight: 400; }
    .lr-arr {
      color: var(--muted);
      transition: transform 160ms var(--ease-out), color 160ms var(--ease-out);
      text-align: right;
    }
    .list-row:hover .lr-arr { color: var(--accent); transform: translateX(3px); }
    .list-empty {
      padding: 36px 4px;
      text-align: center;
      color: var(--muted);
      font-size: 14px;
    }
    .filter-meta {
      font-family: "Geist Mono", monospace;
      font-size: 11.5px;
      color: var(--muted);
    }

    /* ── For agents (dark section) ──────────────────────────── */
    section.dark {
      background: var(--dark);
      color: var(--dark-text);
      padding: 88px 0;
      border-bottom: 0;
      position: relative;
      overflow: hidden;
    }
    section.dark::before {
      content: "";
      position: absolute;
      inset: -20% -10% auto auto;
      width: 600px;
      height: 600px;
      background: radial-gradient(closest-side, rgba(16, 185, 129, .18), transparent 70%);
      pointer-events: none;
    }
    .dark .grid-2 {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
      gap: 56px;
      align-items: center;
      position: relative;
    }
    .dark .eyebrow { color: var(--accent); }
    .dark .eyebrow .dot-led { box-shadow: 0 0 0 2px rgba(16, 185, 129, .25); }
    .dark h2 {
      margin: 12px 0 0;
      font-size: clamp(34px, 4vw, 50px);
      line-height: 1.02;
      letter-spacing: -0.03em;
      font-weight: 600;
      color: #fff;
    }
    .dark p {
      margin: 22px 0 28px;
      color: var(--dark-muted);
      max-width: 480px;
      font-size: 16px;
      line-height: 1.6;
    }
    .dark .actions .btn {
      background: transparent;
      border-color: var(--dark-3);
      color: #fff;
    }
    .dark .actions .btn:hover { border-color: #fff; background: var(--dark-2); }
    .dark .actions .btn.accent { background: var(--accent); border-color: var(--accent); color: #fff; }
    .dark .actions .btn.accent:hover { background: var(--accent-deep); border-color: var(--accent-deep); }

    .terminal {
      background: #050505;
      border: 1px solid var(--dark-3);
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 40px 80px -40px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.04) inset;
    }
    .term-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--dark-3);
      background: var(--dark-2);
    }
    .term-bar .led {
      width: 10px; height: 10px; border-radius: 999px;
      background: #2a2a2a;
    }
    .term-bar .led:nth-child(1) { background: #ff5f57; }
    .term-bar .led:nth-child(2) { background: #febc2e; }
    .term-bar .led:nth-child(3) { background: #28c840; }
    .term-bar .tab {
      margin-left: 14px;
      font-family: "Geist Mono", monospace;
      font-size: 11.5px;
      color: var(--dark-muted);
    }
    .term-body {
      padding: 22px;
      font-family: "Geist Mono", monospace;
      font-size: 13px;
      line-height: 1.75;
      color: #ECECEC;
      white-space: pre;
      overflow-x: auto;
    }
    .term-body .c { color: #7C7C7C; }
    .term-body .p { color: var(--accent); }
    .term-body .k { color: #fff; }
    .term-body .s { color: #B4DCB4; }
    .term-body .a { color: #FDE68A; }

    /* ── Footer ─────────────────────────────────────────────── */
    footer {
      padding: 40px 0 60px;
    }
    .footer-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 24px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 13px;
    }
    .footer-row a:hover { color: var(--ink); }

    @keyframes rise {
      from { opacity: 0; transform: translateY(14px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.001ms !important;
        animation-delay: 0ms !important;
        transition-duration: 120ms !important;
      }
      .signal-track { animation: none; }
    }

    @media (max-width: 1100px) {
      .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (max-width: 960px) {
      .hero { padding: 64px 0 48px; }
      .hero-grid { grid-template-columns: 1fr; gap: 36px; align-items: start; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      section.block, section.dark { padding: 64px 0; }
      .sec-head { flex-direction: column; align-items: flex-start; }
      .dark .grid-2 { grid-template-columns: 1fr; }
      .list-row { grid-template-columns: minmax(0, 1.4fr) auto 28px; gap: 14px; }
      .lr-surfaces { display: none; }
    }
    @media (max-width: 640px) {
      .shell { width: calc(100% - 28px); }
      .nav { min-height: 56px; gap: 12px; }
      .brand { font-size: 14px; }
      .nav-links .nav-link { display: none; }
      .nav-links { gap: 8px; font-size: 12.5px; }
      h1 { font-size: clamp(40px, 11vw, 56px); }
      .grid { grid-template-columns: 1fr 1fr; gap: 10px; }
      .sec-head h2 { font-size: 28px; }
      .term-body { font-size: 12px; padding: 16px; }
      .signal-row { grid-template-columns: 1fr; gap: 12px; padding: 16px 0; }
    }
  </style>
</head>
<body>
  <header>
    <div class="shell nav">
      <a class="brand" href="/">
        <img class="brand-mark" src="/assets/logo-dark-96.png" srcset="/assets/logo-dark-96.png 1x, /assets/logo-dark-192.png 2x" alt="" width="34" height="34">
        <span>GTM Docs Registry</span>
      </a>
      <nav class="nav-links">
        <a class="nav-link" href="#featured">Featured</a>
        <a class="nav-link" href="#catalog">Catalog</a>
        <a class="nav-link" href="#agents">For agents</a>
        <a class="btn" href="https://github.com/Andytoizer/gtm-docs-registry">GitHub</a>
      </nav>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="shell hero-grid">
        <div class="hero-text">
          <div class="eyebrow"><span class="dot-led"></span>${tools.length} GTM tools · verified ${new Date().toISOString().slice(0,10)}</div>
          <h1>The docs <span class="grad">your GTM agents</span> can actually trust.</h1>
          <p class="sub">Source-backed MCP, API, CLI, OpenAPI, SDK and llms.txt profiles for every GTM tool your agent will hit. One JSON call away, never out of date.</p>
          <div class="actions">
            <a class="btn primary btn-lg" href="#catalog">Browse the catalog <span class="arr">→</span></a>
            <a class="btn btn-lg" href="#agents">curl the API</a>
          </div>
          <div class="hero-meta">
            <span><strong>${tools.length}</strong> tools indexed</span>
            <span class="sep">·</span>
            <span><strong>${mcpCount}</strong> official MCP</span>
            <span class="sep">·</span>
            <span><strong>${apiCount}</strong> official API</span>
            <span class="sep">·</span>
            <span><strong>${highReadyCount}</strong> at 5/5 readiness</span>
          </div>
        </div>
        <aside class="hero-search" id="search-card" aria-label="Search the registry">
          <div class="search-row">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5"/><path d="m11 11 3 3"/></svg>
            <input id="search" type="search" autocomplete="off" placeholder="Search ${tools.length} tools — hubspot, lemlist, mcp…">
            <span class="kbd">/</span>
          </div>
          <div class="search-results" id="search-results" role="listbox"></div>
        </aside>
      </div>
    </section>

    <section class="signal" aria-label="Tools in the registry">
      <div class="shell signal-row">
        <span class="signal-label">In the registry</span>
        <div class="signal-marquee">
          <div class="signal-track" id="signal-track"></div>
        </div>
      </div>
    </section>

    <section class="block" id="featured">
      <div class="shell">
        <div class="sec-head">
          <div>
            <div class="eyebrow"><span class="dot-led"></span>Most agent-ready</div>
            <h2>Featured GTM tools.</h2>
            <p>A curated starter set across CRM, outbound, enrichment, data, support, automation, and search.</p>
          </div>
          <div class="right">
            <span class="filter-meta">Curated set · 12 tools</span>
          </div>
        </div>
        <div class="grid">
          ${featuredCardsHtml}
        </div>
      </div>
    </section>

    <section class="block" id="catalog">
      <div class="shell">
        <div class="sec-head">
          <div>
            <div class="eyebrow"><span class="dot-led"></span>Full catalog</div>
            <h2>Every tool, every surface.</h2>
            <p>The complete registry. Filter by name, alias, or surface — click any row to open the source-backed docs.</p>
          </div>
          <div class="right">
            <span class="filter-meta" id="filter-meta">${tools.length} of ${tools.length}</span>
          </div>
        </div>
        <div class="filter-row">
          <input id="catalog-search" type="search" autocomplete="off" placeholder="Filter the catalog…">
          <button class="chip" data-surface="mcp">MCP</button>
          <button class="chip" data-surface="api">API</button>
          <button class="chip" data-surface="cli">CLI</button>
          <button class="chip" data-surface="openapi">OpenAPI</button>
          <button class="chip" data-surface="llms">llms.txt</button>
          <button class="chip" data-surface="sdk">SDK</button>
          <button class="btn" id="clear-filters" style="margin-left:auto">Reset</button>
        </div>
        <div class="list" id="catalog-list"></div>
      </div>
    </section>

    <section class="dark" id="agents">
      <div class="shell grid-2">
        <div>
          <div class="eyebrow"><span class="dot-led"></span>For agents</div>
          <h2>One endpoint. Every GTM tool.</h2>
          <p>Resolve a tool name, fetch focused docs by topic, or search the whole catalog. The same retrieval layer powers the CLI and MCP server — agents and humans see the same source-backed answers.</p>
          <div class="actions">
            <a class="btn accent btn-lg" href="https://github.com/Andytoizer/gtm-docs-registry">Read the docs <span class="arr">→</span></a>
            <a class="btn btn-lg" href="/catalog">/catalog</a>
            <a class="btn btn-lg" href="/registry">/registry</a>
          </div>
        </div>
        <div class="terminal">
          <div class="term-bar">
            <span class="led"></span><span class="led"></span><span class="led"></span>
            <span class="tab">~/agent  ·  gtm-docs-registry</span>
          </div>
          <div class="term-body"><span class="c"># Resolve a tool by name or alias</span>
<span class="p">$</span> <span class="k">curl</span> <span class="s">"https://gtm-docs-registry.vercel.app/tools/resolve?<span class="a">query=hubspot</span>"</span>

<span class="c"># Fetch focused docs by topic</span>
<span class="p">$</span> <span class="k">curl</span> <span class="s">"…/tools/lemlist/docs?<span class="a">topic=mcp&amp;format=json</span>"</span>

<span class="c"># Search across the catalog</span>
<span class="p">$</span> <span class="k">curl</span> <span class="s">"…/tools/search?<span class="a">q=openapi&amp;limit=10</span>"</span>
</div>
        </div>
      </div>
    </section>
  </main>

  <footer>
    <div class="shell footer-row">
      <span>Open-source, MIT. Built for agent developers.</span>
      <span><a href="https://github.com/Andytoizer/gtm-docs-registry">GitHub</a>  ·  Updated ${new Date().toISOString().slice(0,10)}</span>
    </div>
  </footer>

  <script type="application/json" id="tool-data">${toolsJson}</script>
  <script>
  (function () {
    const tools = JSON.parse(document.getElementById("tool-data").textContent);
    const SURFACE_ORDER = ["mcp", "api", "cli", "openapi", "llms", "sdk"];
    const SURFACE_LABEL = { mcp: "MCP", api: "API", cli: "CLI", openapi: "OpenAPI", llms: "llms.txt", sdk: "SDK" };

    const heroSearch = document.getElementById("search");
    const searchResults = document.getElementById("search-results");
    const searchCard = document.getElementById("search-card");

    const catalogSearch = document.getElementById("catalog-search");
    const list = document.getElementById("catalog-list");
    const filterMeta = document.getElementById("filter-meta");
    const clearBtn = document.getElementById("clear-filters");
    const surfaceChips = Array.from(document.querySelectorAll(".chip[data-surface]"));

    let activeSurface = null;   // 'mcp' | 'api' | ...
    let catalogQuery = "";

    function esc(v) {
      return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
    }
    function toolHay(t) {
      return [t.name, t.id, t.slug, ...(t.aliases || [])].join(" ").toLowerCase();
    }
    function toolMatchesSurface(t, key) {
      const v = t.surfaces[key];
      return v === "yes" || v === "announced";
    }
    // ── Build the marquee ─────────────────────────────────────────────
    (function buildMarquee() {
      const track = document.getElementById("signal-track");
      const wellKnown = ["HubSpot","Salesforce","Attio","Apollo","Clay","Smartlead","Lemlist","Customer.io","Klaviyo","Segment","Mixpanel","Amplitude","Outreach","Salesloft","Intercom","Pipedrive","Iterable","Braze","Mailchimp","Stripe","Snowflake","Cal.com","Linear","Notion","Slack","Zoom","Calendly","HeyReach","Instantly","Findymail"];
      const haveIds = new Set(tools.map((t) => t.name));
      let names = wellKnown.filter((n) => haveIds.has(n));
      if (names.length < 10) {
        names = tools.slice(0, 24).map((t) => t.name);
      }
      const items = names.concat(names).map((n) => '<span>' + esc(n) + '</span>').join("");
      track.innerHTML = items;
    })();

    // ── Hero search: live suggestions dropdown ────────────────────────
    function renderHeroResults(q) {
      const query = q.trim().toLowerCase();
      if (!query) {
        searchResults.removeAttribute("data-open");
        searchResults.innerHTML = "";
        return;
      }
      const hits = tools.filter((t) => toolHay(t).includes(query)).slice(0, 6);
      if (!hits.length) {
        searchResults.innerHTML = '<div class="sr-empty">No tools match "' + esc(q) + '".</div>';
      } else {
        const rows = hits.map((t) => {
          const surfaces = SURFACE_ORDER.filter((k) => toolMatchesSurface(t, k)).map((k) => SURFACE_LABEL[k]).join(" · ");
          return '<a class="sr-row" href="/tools/' + encodeURIComponent(t.slug) + '/docs">' +
            '<div><div class="sr-name">' + esc(t.name) + '</div><div class="sr-meta">' + esc(surfaces || "profile only") + '</div></div>' +
            '<div class="sr-score">' + esc(t.score) + '/5</div>' +
            '<div class="sr-arr">→</div>' +
          '</a>';
        }).join("");
        const total = tools.filter((t) => toolHay(t).includes(query)).length;
        const more = total > hits.length
          ? '<a class="sr-more" href="#catalog" data-pass="' + esc(q) + '">See all ' + total + ' matches in the catalog ↓</a>'
          : "";
        searchResults.innerHTML = rows + more;
      }
      searchResults.setAttribute("data-open", "true");
    }

    heroSearch.addEventListener("input", (e) => renderHeroResults(e.target.value));
    heroSearch.addEventListener("focus", (e) => { if (e.target.value) renderHeroResults(e.target.value); });
    document.addEventListener("click", (e) => {
      if (!searchCard.contains(e.target)) {
        searchResults.removeAttribute("data-open");
      }
    });

    // "See all matches" hand-off to catalog
    searchResults.addEventListener("click", (e) => {
      const more = e.target.closest("[data-pass]");
      if (more) {
        e.preventDefault();
        const q = more.getAttribute("data-pass");
        catalogSearch.value = q;
        catalogQuery = q;
        clearSurfaceFilter();
        renderCatalog();
        searchResults.removeAttribute("data-open");
        heroSearch.value = "";
        document.getElementById("catalog").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });

    // ── Surface chips inside catalog ──────────────────────────────────
    surfaceChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const surface = chip.dataset.surface;
        const wasActive = activeSurface === surface;
        surfaceChips.forEach((c) => c.removeAttribute("data-active"));
        if (wasActive) {
          activeSurface = null;
        } else {
          activeSurface = surface;
          chip.dataset.active = "true";
        }
        renderCatalog();
      });
    });

    function clearSurfaceFilter() {
      activeSurface = null;
      surfaceChips.forEach((c) => c.removeAttribute("data-active"));
    }

    clearBtn.addEventListener("click", () => {
      clearSurfaceFilter();
      catalogSearch.value = "";
      catalogQuery = "";
      renderCatalog();
    });

    catalogSearch.addEventListener("input", (e) => {
      catalogQuery = e.target.value;
      renderCatalog();
    });

    // Esc clears whichever input is focused
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement !== heroSearch && document.activeElement !== catalogSearch && document.activeElement.tagName !== "INPUT") {
        e.preventDefault();
        heroSearch.focus();
      }
      if (e.key === "Escape") {
        if (document.activeElement === heroSearch) {
          heroSearch.value = "";
          renderHeroResults("");
          heroSearch.blur();
        } else if (document.activeElement === catalogSearch) {
          catalogSearch.value = "";
          catalogQuery = "";
          renderCatalog();
        }
      }
    });

    // ── Render the catalog list ───────────────────────────────────────
    function rowHtml(t) {
      const surfaces = SURFACE_ORDER.filter((k) => toolMatchesSurface(t, k)).slice(0, 5);
      const pills = surfaces.map((k) => {
        const cls = t.surfaces[k] === "yes" ? "ok" : "soon";
        return '<span class="pill ' + cls + '">' + SURFACE_LABEL[k] + '</span>';
      }).join("");
      return '<a class="list-row" href="/tools/' + encodeURIComponent(t.slug) + '/docs">' +
        '<div><div class="lr-name">' + esc(t.name) + '</div><div class="lr-id">' + esc(t.id) + '</div></div>' +
        '<div class="lr-surfaces">' + (pills || '<span class="lr-id">profile only</span>') + '</div>' +
        '<div class="lr-score">' + esc(t.score) + '<i>/5</i></div>' +
        '<div class="lr-arr">→</div>' +
      '</a>';
    }
    function renderCatalog() {
      let pool = tools;
      if (activeSurface) pool = pool.filter((t) => toolMatchesSurface(t, activeSurface));
      if (catalogQuery.trim()) {
        const q = catalogQuery.trim().toLowerCase();
        pool = pool.filter((t) => toolHay(t).includes(q));
      }
      // Sort: readiness desc, then name asc
      pool = [...pool].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || a.name.localeCompare(b.name));
      if (!pool.length) {
        list.innerHTML = '<div class="list-empty">No tools match the current filter. Try Reset.</div>';
      } else {
        list.innerHTML = pool.map(rowHtml).join("");
      }
      const filterDesc = [
        activeSurface ? activeSurface : null,
        catalogQuery.trim() ? '"' + catalogQuery.trim() + '"' : null
      ].filter(Boolean).join(" · ");
      filterMeta.textContent = filterDesc
        ? pool.length + " of " + tools.length + "  ·  " + filterDesc
        : pool.length + " of " + tools.length;
    }

    renderCatalog();
  })();
  </script>
</body>
</html>`;
}

function renderToolDocsPage({ tool, files, sources, topic, result }) {
  const home = homeTool(tool);
  const title = `${tool.name} Docs | GTM Docs Registry`;
  const jsonHref = `/tools/${encodeURIComponent(tool.slug)}/docs${topic ? `?topic=${encodeURIComponent(topic)}&format=json` : "?format=json"}`;
  const topicParam = topic ? `?topic=${encodeURIComponent(topic)}` : "";
  const docsHtml = result
    ? result.selected.map((section) => markdownToHtml(section.text)).join("\n")
    : markdownToHtml(files.docs);
  const referenceHtml = !result && files.hasReference ? markdownToHtml(files.referenceText || files.reference) : "";
  const sourceHtml = renderSourceList(result?.relatedSources || sources);
  const surfaceOrder = ["mcp", "api", "cli", "openapi", "llms", "sdk"];
  const surfaceRow = surfaceOrder.map((key) => {
    const v = home.surfaces[key] || "no";
    const cls = v === "yes" ? "ok" : v === "announced" ? "soon" : "off";
    return `<span class="dot ${cls}" title="${surfaceLabel(key)}: ${v}"><span>${surfaceLabel(key)}</span></span>`;
  }).join("");
  const initial = (tool.name[0] || "·").toUpperCase();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="Source-backed agent and human docs for ${escapeHtml(tool.name)}.">
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-dark-32.png">
  <link rel="icon" type="image/png" sizes="192x192" href="/assets/logo-dark-192.png">
  <link rel="apple-touch-icon" href="/assets/apple-touch-icon-dark.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
  <style>
    :root {
      color-scheme: light;
      --bg: #FFFFFF;
      --bg-2: #FAFAF9;
      --bg-3: #F5F5F4;
      --ink: #0A0A0A;
      --ink-2: #262626;
      --ink-3: #404040;
      --muted: #737373;
      --muted-2: #A3A3A3;
      --rule: #E7E5E4;
      --rule-soft: #F0EFED;
      --accent: #10B981;
      --accent-deep: #059669;
      --accent-tint: #ECFDF5;
      --warn: #F59E0B;
      --warn-tint: #FFFBEB;
      --dark: #0A0A0A;
      --dark-2: #171717;
      --dark-3: #262626;
      --dark-text: #FAFAFA;
      --dark-muted: #A3A3A3;
      --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
    }
    *, *::before, *::after { box-sizing: border-box; }
    html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    body {
      margin: 0;
      font-family: "Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
      color: var(--ink);
      background: var(--bg);
      line-height: 1.55;
      letter-spacing: -0.005em;
    }
    a { color: inherit; text-decoration: none; }
    ::selection { background: var(--ink); color: #fff; }
    .shell { width: min(1180px, calc(100% - 40px)); margin: 0 auto; }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: "Geist Mono", monospace;
      font-size: 11.5px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 500;
    }
    .eyebrow .dot-led {
      width: 6px; height: 6px; border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 0 2px rgba(16, 185, 129, .18);
      animation: ledPulse 2.4s cubic-bezier(.77,0,.175,1) infinite;
    }
    @keyframes ledPulse {
      0%, 100% { box-shadow: 0 0 0 2px rgba(16, 185, 129, .18); }
      50%      { box-shadow: 0 0 0 5px rgba(16, 185, 129, .08); }
    }

    header {
      position: sticky;
      top: 0;
      z-index: 30;
      background: rgba(255,255,255,.78);
      backdrop-filter: saturate(160%) blur(14px);
      -webkit-backdrop-filter: saturate(160%) blur(14px);
      border-bottom: 1px solid var(--rule);
    }
    .nav {
      min-height: 60px;
      display: flex; align-items: center; justify-content: space-between; gap: 24px;
    }
    .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 600; font-size: 15px; letter-spacing: -0.01em; }
    .brand-mark {
      width: 34px; height: 34px;
      border-radius: 8px;
      display: block; flex-shrink: 0;
      object-fit: cover;
    }
    .nav-links { display: flex; align-items: center; gap: 26px; font-size: 13.5px; color: var(--ink-3); }
    .nav-link:hover { color: var(--ink); }

    .btn {
      display: inline-flex; align-items: center; gap: 8px;
      height: 34px; padding: 0 14px;
      border-radius: 8px; border: 1px solid var(--rule);
      background: #fff; color: var(--ink);
      font: inherit; font-size: 13px; font-weight: 500;
      cursor: pointer;
      transition: transform 160ms var(--ease-out), background 160ms var(--ease-out), border-color 160ms var(--ease-out), color 160ms var(--ease-out), box-shadow 200ms var(--ease-out);
    }
    .btn:hover { border-color: var(--ink-3); }
    .btn:active { transform: scale(0.97); }
    .btn.primary { background: var(--ink); color: #fff; border-color: var(--ink); }
    .btn.primary:hover { background: var(--ink-2); border-color: var(--ink-2); box-shadow: 0 6px 20px -8px rgba(10,10,10,.4); }
    .btn.accent { background: var(--accent); color: #fff; border-color: var(--accent); }
    .btn.accent:hover { background: var(--accent-deep); border-color: var(--accent-deep); box-shadow: 0 6px 20px -8px rgba(16,185,129,.5); }
    .btn .arr { transition: transform 200ms var(--ease-out); }
    .btn:hover .arr { transform: translateX(3px); }
    .btn-lg { height: 42px; padding: 0 18px; font-size: 14px; border-radius: 10px; }

    main { padding: 48px 0 80px; }

    .crumbs {
      display: inline-flex; align-items: center; gap: 8px;
      font-family: "Geist Mono", monospace;
      font-size: 11.5px; letter-spacing: 0.04em; text-transform: uppercase;
      color: var(--muted);
    }
    .crumbs a { color: var(--accent-deep); }
    .crumbs a:hover { color: var(--accent); }
    .crumbs .sep { color: var(--rule); }

    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(300px, 1fr);
      gap: 56px;
      align-items: end;
      padding: 24px 0 40px;
      border-bottom: 1px solid var(--rule);
      margin-bottom: 48px;
    }
    .hero-left > * { opacity: 0; transform: translateY(10px); animation: rise 600ms var(--ease-out) forwards; }
    .crumbs { animation-delay: 40ms; }
    h1 { animation-delay: 120ms; }
    .sub { animation-delay: 200ms; }
    .actions { animation-delay: 280ms; }

    h1 {
      margin: 14px 0 0;
      font-size: clamp(40px, 5vw, 64px);
      line-height: 1.02;
      letter-spacing: -0.03em;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 18px;
    }
    h1 .logo-lg {
      display: inline-grid;
      place-items: center;
      width: 56px; height: 56px;
      border-radius: 12px;
      background: var(--ink);
      color: #fff;
      font-size: 26px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .sub {
      max-width: 580px;
      margin: 18px 0 0;
      color: var(--ink-3);
      font-size: 16.5px;
      line-height: 1.55;
    }
    .actions {
      display: flex;
      gap: 10px;
      margin-top: 28px;
      flex-wrap: wrap;
    }

    .meta-card {
      background: var(--bg);
      border: 1px solid var(--rule);
      border-radius: 14px;
      padding: 22px;
      box-shadow: 0 1px 0 #fff inset, 0 20px 50px -28px rgba(10,10,10,.18);
      opacity: 0;
      animation: rise 700ms var(--ease-out) 280ms forwards;
    }
    .meta-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px; padding: 12px 0;
      border-bottom: 1px solid var(--rule-soft);
    }
    .meta-row:first-child { padding-top: 0; }
    .meta-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .meta-key {
      font-family: "Geist Mono", monospace;
      font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase;
      color: var(--muted);
    }
    .meta-val {
      font-family: "Geist Mono", monospace;
      font-size: 12.5px; font-weight: 500;
      color: var(--ink);
    }
    .meta-val.score {
      font-size: 16px;
    }
    .meta-val.score i { color: var(--muted); font-style: normal; font-weight: 400; }
    .meta-surfaces {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 4px;
      margin-top: 14px;
    }
    .dot {
      height: 26px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      font-family: "Geist Mono", monospace;
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    .dot.ok { background: var(--accent); color: #fff; }
    .dot.soon { background: var(--warn-tint); color: var(--warn); border: 1px solid #FDE68A; }
    .dot.off { background: var(--bg-3); color: var(--muted-2); }

    .content {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 304px;
      gap: 48px;
      align-items: start;
    }

    .doc {
      min-width: 0;
      font-size: 16px;
      line-height: 1.7;
      color: var(--ink-2);
      overflow-wrap: anywhere;
    }
    .topic-note {
      margin-bottom: 28px;
      padding: 14px 18px;
      border-radius: 10px;
      background: var(--accent-tint);
      border: 1px solid #BBF7D0;
      color: var(--ink-2);
      font-size: 14px;
    }
    .topic-note strong { color: var(--accent-deep); font-weight: 600; }
    .topic-note a { color: var(--ink); text-decoration: underline; text-decoration-color: var(--accent); text-underline-offset: 3px; }

    .doc h2 {
      margin: 44px 0 14px;
      font-size: 26px;
      line-height: 1.15;
      letter-spacing: -0.02em;
      font-weight: 600;
      color: var(--ink);
    }
    .doc h2:first-child { margin-top: 0; }
    .doc h3 {
      margin: 28px 0 10px;
      font-size: 18px;
      letter-spacing: -0.01em;
      font-weight: 600;
      color: var(--ink);
    }
    .doc p { margin: 0 0 16px; }
    .doc ul { margin: 0 0 18px; padding-left: 22px; }
    .doc li { margin: 6px 0; }
    .doc li::marker { color: var(--accent); }
    .doc a {
      color: var(--ink);
      text-decoration: underline;
      text-decoration-color: var(--accent);
      text-underline-offset: 3px;
      text-decoration-thickness: 1px;
      transition: color 160ms var(--ease-out);
    }
    .doc a:hover { color: var(--accent-deep); }
    .doc code {
      font-family: "Geist Mono", monospace;
      font-size: 0.9em;
      background: var(--bg-2);
      border: 1px solid var(--rule);
      border-radius: 4px;
      padding: 1px 6px;
      color: var(--ink);
    }
    .doc pre {
      overflow: auto;
      border-radius: 12px;
      background: #050505;
      color: #ECECEC;
      padding: 22px;
      border: 1px solid var(--dark-3);
      font-family: "Geist Mono", monospace;
      font-size: 13px;
      line-height: 1.7;
      margin: 0 0 22px;
      box-shadow: 0 30px 70px -40px rgba(10,10,10,.5);
    }
    .doc pre code {
      padding: 0; border: 0; background: transparent; color: inherit; font-size: inherit;
    }

    .aside {
      display: grid;
      gap: 16px;
      position: sticky;
      top: 88px;
    }
    .aside-panel {
      background: var(--bg);
      border: 1px solid var(--rule);
      border-radius: 14px;
      padding: 20px;
    }
    .aside-panel h2 {
      margin: 0 0 14px;
      font-family: "Geist Mono", monospace;
      font-size: 11px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 500;
    }
    .aside-blurb {
      margin: 0 0 16px;
      font-size: 14px;
      line-height: 1.5;
      color: var(--ink-3);
    }
    .source-list {
      list-style: none; padding: 0; margin: 0;
      display: grid; gap: 12px;
    }
    .source-list li {
      padding-left: 14px;
      border-left: 1px solid var(--rule);
      transition: border-color 200ms var(--ease-out);
    }
    .source-list li:hover { border-left-color: var(--accent); }
    .source-list a {
      display: block;
      font-size: 13px;
      line-height: 1.4;
      color: var(--ink);
      overflow-wrap: anywhere;
      transition: color 160ms var(--ease-out);
    }
    .source-list a:hover { color: var(--accent-deep); }
    .source-type {
      display: block;
      margin-top: 4px;
      font-family: "Geist Mono", monospace;
      font-size: 10.5px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
    }

    footer {
      margin-top: 88px;
      padding: 36px 0 56px;
      border-top: 1px solid var(--rule);
    }
    .footer-row {
      display: flex; justify-content: space-between; align-items: center;
      gap: 24px; flex-wrap: wrap;
      color: var(--muted); font-size: 13px;
    }
    .footer-row a:hover { color: var(--ink); }

    @keyframes rise {
      from { opacity: 0; transform: translateY(14px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.001ms !important;
        animation-delay: 0ms !important;
        transition-duration: 120ms !important;
      }
    }

    @media (max-width: 960px) {
      .hero { grid-template-columns: 1fr; gap: 28px; align-items: start; }
      .content { grid-template-columns: 1fr; gap: 36px; }
      .aside { position: static; }
    }
    @media (max-width: 640px) {
      main { padding: 28px 0 56px; }
      .nav { min-height: 56px; gap: 12px; }
      .nav-links { gap: 10px; font-size: 12.5px; }
      .nav-links .nav-link { display: none; }
      h1 { font-size: clamp(34px, 9vw, 48px); gap: 12px; }
      h1 .logo-lg { width: 44px; height: 44px; font-size: 20px; }
      .doc { font-size: 15px; }
      .doc h2 { font-size: 22px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="shell nav">
      <a class="brand" href="/">
        <img class="brand-mark" src="/assets/logo-dark-96.png" srcset="/assets/logo-dark-96.png 1x, /assets/logo-dark-192.png 2x" alt="" width="34" height="34">
        <span>GTM Docs Registry</span>
      </a>
      <nav class="nav-links">
        <a class="nav-link" href="/#featured">Featured</a>
        <a class="nav-link" href="/#catalog">Catalog</a>
        <a class="nav-link" href="/#agents">For agents</a>
        <a class="btn" href="${escapeHtml(jsonHref)}">Agent JSON <span class="arr">→</span></a>
      </nav>
    </div>
  </header>
  <main class="shell">
    <section class="hero">
      <div class="hero-left">
        <div class="crumbs">
          <a href="/#catalog">Catalog</a>
          <span class="sep">/</span>
          <span>${escapeHtml(tool.name)}</span>
        </div>
        <h1><span class="logo-lg">${escapeHtml(initial)}</span>${escapeHtml(tool.name)}</h1>
        <p class="sub">Human-readable profile for review and exploration. Agents can pull the same source-backed retrieval content as structured JSON.</p>
        <div class="actions">
          <a class="btn accent btn-lg" href="${escapeHtml(jsonHref)}">Agent JSON <span class="arr">→</span></a>
          <a class="btn btn-lg" href="/tools/${encodeURIComponent(tool.slug)}/sources">Sources JSON</a>
          <a class="btn btn-lg" href="/#catalog">Back to catalog</a>
        </div>
      </div>
      <aside class="meta-card" aria-label="Tool metadata">
        <div class="meta-row">
          <span class="meta-key">ID</span>
          <span class="meta-val">${escapeHtml(tool.id)}</span>
        </div>
        <div class="meta-row">
          <span class="meta-key">Readiness</span>
          <span class="meta-val score">${escapeHtml(tool.agentReadinessScore)}<i>/5</i></span>
        </div>
        <div class="meta-row">
          <span class="meta-key">Last verified</span>
          <span class="meta-val">${escapeHtml(tool.lastVerified || "unknown")}</span>
        </div>
        <div>
          <div class="meta-key">Surfaces</div>
          <div class="meta-surfaces">${surfaceRow}</div>
        </div>
      </aside>
    </section>
    <section class="content">
      <article class="doc">
        ${topic ? `<div class="topic-note">Showing focused retrieval results for <strong>${escapeHtml(topic)}</strong>. <a href="/tools/${encodeURIComponent(tool.slug)}/docs${escapeHtml(topicParam)}&format=json">Open the agent JSON response.</a></div>` : ""}
        ${docsHtml}
        ${referenceHtml ? `<h2>Reference details</h2>${referenceHtml}` : ""}
      </article>
      <aside class="aside">
        <section class="aside-panel">
          <h2>Agent access</h2>
          <p class="aside-blurb">JSON for agents, MCP servers, scripts, and retrieval calls.</p>
          <a class="btn accent" href="${escapeHtml(jsonHref)}" style="width:100%;justify-content:center;">Open JSON <span class="arr">→</span></a>
        </section>
        <section class="aside-panel">
          <h2>Sources</h2>
          ${sourceHtml}
        </section>
      </aside>
    </section>
  </main>
  <footer>
    <div class="shell footer-row">
      <span>Open-source, MIT. Built for agent developers.</span>
      <span><a href="https://github.com/Andytoizer/gtm-docs-registry">GitHub</a></span>
    </div>
  </footer>
</body>
</html>`;
}

function surfaceLabel(key) {
  return ({ mcp: "MCP", api: "API", cli: "CLI", openapi: "OpenAPI", llms: "llms.txt", sdk: "SDK" })[key] || key;
}

function renderSourceList(sources) {
  const items = (sources || []).slice(0, 12).map((source) => {
    const label = source.label || source.title || source.url || "Source";
    const type = source.type || "source";
    const href = source.url || "#";
    return `<li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a><span class="source-type">${escapeHtml(type)}</span></li>`;
  });
  return items.length ? `<ul class="source-list">${items.join("")}</ul>` : `<p>No source metadata found.</p>`;
}

function markdownToHtml(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let inList = false;
  let inCode = false;
  let codeLines = [];

  function closeList() {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  }

  function closeCode() {
    if (inCode) {
      html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      inCode = false;
      codeLines = [];
    }
  }

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) {
        closeCode();
      } else {
        closeList();
        inCode = true;
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 1, 4);
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${renderInline(trimmed)}</p>`);
  }

  closeCode();
  closeList();
  return html.join("\n");
}

function renderInline(value) {
  return String(value ?? "")
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
    })
    .join("");
}

const STATIC_MIME = {
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp"
};

function handleStatic(res, relPath) {
  const ext = path.extname(relPath).toLowerCase();
  const mime = STATIC_MIME[ext];
  if (!mime) {
    sendError(res, 404, "Not found.");
    return;
  }
  const safe = relPath.replace(/\.\.+/g, "");
  const filePath = path.join(root, "http", "assets", safe);
  try {
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": mime,
      "Cache-Control": "public, max-age=86400, immutable",
      "Content-Length": body.length
    });
    res.end(body);
  } catch {
    sendError(res, 404, "Not found.");
  }
}

function routeRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const segments = reqUrl.pathname.split("/").filter(Boolean);
  const pathKey = `/${segments.join("/")}`;

  if (req.method === "POST" && pathKey === "/mcp") {
    handleMcpPost(req, res).catch((error) => {
      sendJson(res, 500, mcpError(null, -32603, error instanceof Error ? error.message : String(error)));
    });
    return;
  }

  if (req.method !== "GET") {
    sendError(res, 405, "Method not allowed. Use GET.");
    return;
  }

  try {
    if (segments[0] === "assets" && segments.length >= 2) {
      handleStatic(res, segments.slice(1).map(decodeSegment).join("/"));
      return;
    }

    if (pathKey === "/favicon.ico" || pathKey === "/favicon.png") {
      handleStatic(res, "favicon-dark-32.png");
      return;
    }

    if (pathKey === "/apple-touch-icon.png" || pathKey === "/apple-touch-icon-precomposed.png") {
      handleStatic(res, "apple-touch-icon-dark.png");
      return;
    }

    if (pathKey === "/health") {
      handleHealth(res);
      return;
    }

    if (pathKey === "/") {
      handleHome(res);
      return;
    }

    if (pathKey === "/llms.txt") {
      handleLlms(res, false);
      return;
    }

    if (pathKey === "/llms-full.txt") {
      handleLlms(res, true);
      return;
    }

    if (pathKey === "/openapi.json") {
      handleOpenApi(res);
      return;
    }

    if (pathKey === "/mcp") {
      handleMcpInfo(res);
      return;
    }

    if (pathKey === "/registry") {
      handleRegistry(res);
      return;
    }

    if (pathKey === "/catalog") {
      handleCatalog(res);
      return;
    }

    if (pathKey === "/tools/search") {
      handleSearch(reqUrl, res);
      return;
    }

    if (pathKey === "/tools/resolve") {
      handleResolve(reqUrl, res);
      return;
    }

    if (segments[0] === "tools" && segments.at(-1) === "docs") {
      handleDocs(req, reqUrl, res, toolFromPath(segments, "docs"));
      return;
    }

    if (segments[0] === "tools" && segments.at(-1) === "sources") {
      handleSources(res, toolFromPath(segments, "sources"));
      return;
    }

    sendError(res, 404, "Not found.");
  } catch (error) {
    sendError(res, 500, "Internal server error.", error instanceof Error ? error.message : String(error));
  }
}

export { routeRequest };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = http.createServer(routeRequest);

  server.listen(port, () => {
    console.log(`GTM Docs Registry HTTP server listening on http://localhost:${port}`);
  });
}
