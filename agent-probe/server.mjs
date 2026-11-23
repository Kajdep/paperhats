#!/usr/bin/env node
// Agent connection probe: a tiny MCP server that records what each personal
// agent (Hermes, OpenClaw, Grok Bot, Dot, Muse, Cue, ...) can actually do.
//
// Zero dependencies. Node 22+. Stateless Streamable HTTP MCP with JSON replies.
//
//   node server.mjs                      # http://localhost:8787
//   PUBLIC_URL=https://x.trycloudflare.com node server.mjs
//
// Each agent gets its own secret URL: <PUBLIC_URL>/mcp/<token>
// The dashboard is at <PUBLIC_URL>/?admin=<adminToken> (printed on start).

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.resolve(process.env.PROBE_DATA_DIR || path.join(HERE, "data"));
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SERVER_VERSION = "0.1.0";
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const DEFAULT_AGENTS = [
  { handle: "hermes", name: "Hermes Agent", platform: "nous", wake: "Hermes gateway / local process" },
  { handle: "openclaw", name: "OpenClaw", platform: "openclaw", wake: "OpenClaw gateway / local process" },
  { handle: "grok-bot", name: "Grok Bot", platform: "xai", wake: "Routine webhook panel (URL + key)" },
  { handle: "dot", name: "OpenAI Dot", platform: "openai", wake: "MCP Events / callback URL" },
  { handle: "muse", name: "Meta Muse", platform: "meta", wake: "Managed hook" },
  { handle: "cue", name: "Manus Cue", platform: "manus", wake: "Unknown (to be discovered)" },
];

// ---------------------------------------------------------------- storage

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const token = (bytes = 18) => crypto.randomBytes(bytes).toString("base64url");

export function createStore(dataDir = DATA_DIR) {
  const configFile = path.join(dataDir, "config.json");
  const stateFile = path.join(dataDir, "state.json");
  const eventsFile = path.join(dataDir, "events.jsonl");

  let config = readJson(configFile, null);
  if (!config) {
    config = {
      adminToken: token(24),
      agents: DEFAULT_AGENTS.map((a) => ({ ...a, token: token() })),
    };
    writeJson(configFile, config);
  }

  let state = readJson(stateFile, { agents: {} });
  const agentState = (handle) => {
    state.agents[handle] ??= {
      firstSeenAt: null,
      lastSeenAt: null,
      userAgents: [],
      httpHits: 0,
      methods: {},
      tools: {},
      oauthDiscovery: false,
      protocolVersion: null,
      clientInfo: null,
      report: null,
      wake: null,
      wakeTests: [],
      echoes: [],
    };
    return state.agents[handle];
  };
  const save = () => writeJson(stateFile, state);

  const log = (event) => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(eventsFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  };

  return {
    get config() {
      return config;
    },
    get state() {
      return state;
    },
    agentByToken: (t) => {
      if (!t) return undefined;
      const want = crypto.createHash("sha256").update(String(t)).digest();
      return config.agents.find((a) => crypto.timingSafeEqual(crypto.createHash("sha256").update(a.token).digest(), want));
    },
    agentByHandle: (h) => config.agents.find((a) => a.handle === h),
    agentState,
    save,
    log,
    eventsFile,
    addAgent(handle, name) {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(handle)) throw new Error("handle must be lowercase letters, digits and dashes");
      if (config.agents.some((a) => a.handle === handle)) throw new Error("handle already exists");
      const agent = { handle, name: name || handle, platform: "other", wake: "Unknown", token: token() };
      config.agents.push(agent);
      writeJson(configFile, config);
      return agent;
    },
    rotate(handle) {
      const agent = config.agents.find((a) => a.handle === handle);
      if (!agent) throw new Error("unknown agent");
      agent.token = token();
      writeJson(configFile, config);
      return agent;
    },
  };
}

// ---------------------------------------------------------------- results

export function resultsFor(store) {
  return store.config.agents.map((agent) => {
    const s = store.agentState(agent.handle);
    const lastWake = s.wakeTests.at(-1) || null;
    const acked = s.wakeTests.find((w) => w.ackedAt);
    return {
      handle: agent.handle,
      name: agent.name,
      reached: s.httpHits > 0,
      oauthDiscoveryAttempted: s.oauthDiscovery,
      initialize: Boolean(s.methods.initialize),
      toolsList: Boolean(s.methods["tools/list"]),
      toolCall: Object.keys(s.tools).length > 0,
      echoRoundTrip: s.echoes.length > 0,
      selfReport: s.report,
      wakeRegistered: Boolean(s.wake?.url),
      wakeDelivered: s.wakeTests.some((w) => w.status >= 200 && w.status < 300),
      wakeAcked: Boolean(acked),
      wakeLatencySeconds: acked ? Math.round((Date.parse(acked.ackedAt) - Date.parse(acked.sentAt)) / 1000) : null,
      lastWake,
      protocolVersion: s.protocolVersion,
      clientInfo: s.clientInfo,
      userAgents: s.userAgents,
      lastSeenAt: s.lastSeenAt,
      expectedWake: agent.wake,
    };
  });
}

// ---------------------------------------------------------------- MCP tools

const TOOLS = [
  {
    name: "probe_whoami",
    description: "Connection test. Returns which agent identity this MCP URL belongs to. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "probe_echo",
    description: "Connection test. Echoes the message back so the round trip can be verified.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Any short text." } },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "probe_report",
    description:
      "Connection test. Describe your own capabilities honestly so the operator can plan how agents coordinate. " +
      "Only report what you can actually do; use 'unknown' when unsure.",
    inputSchema: {
      type: "object",
      properties: {
        agent_product: { type: "string", description: "Your product name, e.g. 'Grok Bot', 'OpenAI Dot', 'Hermes Agent'." },
        model: { type: "string", description: "Model you run on, if known." },
        can_run_on_schedule: { type: "string", enum: ["yes", "no", "unknown"] },
        can_be_woken_by_http: { type: "string", enum: ["yes", "no", "unknown"], description: "Can an external HTTP request start a new turn for you?" },
        wake_mechanism: { type: "string", description: "How you can be woken: webhook URL, MCP event subscription, hook, chat message, email, etc." },
        can_make_http_requests: { type: "string", enum: ["yes", "no", "unknown"] },
        can_read_write_files: { type: "string", enum: ["yes", "no", "unknown"] },
        persistent_memory: { type: "string", description: "Where your long-term memory lives and whether the user can inspect it." },
        other_channels: { type: "string", description: "Other ways you can talk: Slack, Telegram, email, SMS, group chat..." },
        limitations: { type: "string", description: "Anything that would stop you coordinating with other agents." },
      },
      required: ["agent_product"],
      additionalProperties: false,
    },
  },
  {
    name: "probe_register_wake",
    description:
      "Connection test. If you own an HTTPS URL that wakes you (a webhook, callback or event endpoint), register it here so the operator can test waking you. " +
      "Do not put secrets here; the operator adds any required key in the dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTPS URL that starts a new turn for you when POSTed to." },
        notes: { type: "string", description: "Payload format or anything the operator should know." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "probe_ack",
    description: "Connection test. When you are woken with a probe nonce, call this with that nonce to prove the wake reached you.",
    inputSchema: {
      type: "object",
      properties: { nonce: { type: "string" } },
      required: ["nonce"],
      additionalProperties: false,
    },
  },
];

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const toolError = (message) => ({ content: [{ type: "text", text: message }], isError: true });

function validUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return u.toString();
    if (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return u.toString();
  } catch {}
  return null;
}

function callTool(store, agent, name, args = {}) {
  const s = store.agentState(agent.handle);
  switch (name) {
    case "probe_whoami":
      return text({
        handle: agent.handle,
        name: agent.name,
        message: `You are connected to the agent probe as @${agent.handle}. Next: call probe_echo, then probe_report.`,
      });
    case "probe_echo": {
      const message = String(args.message ?? "").slice(0, 500);
      s.echoes.push({ at: new Date().toISOString(), message });
      s.echoes = s.echoes.slice(-10);
      return text({ echo: message, receivedAt: new Date().toISOString() });
    }
    case "probe_report": {
      const report = {};
      for (const key of Object.keys(TOOLS[2].inputSchema.properties)) {
        if (args[key] != null) report[key] = String(args[key]).slice(0, 1000);
      }
      s.report = { ...report, reportedAt: new Date().toISOString() };
      return text("Thanks, report saved. If you have a wake URL, call probe_register_wake.");
    }
    case "probe_register_wake": {
      const url = validUrl(String(args.url ?? ""));
      if (!url) return toolError("url must be an https:// URL (http only for localhost)");
      s.wake = { ...(s.wake || {}), url, notes: String(args.notes ?? "").slice(0, 1000), registeredBy: "agent", registeredAt: new Date().toISOString() };
      return text("Wake URL registered. The operator will send a test wake containing a nonce; call probe_ack with it.");
    }
    case "probe_ack": {
      const nonce = String(args.nonce ?? "");
      const test = s.wakeTests.find((w) => w.nonce === nonce);
      if (!test) return toolError("Unknown nonce for this agent.");
      test.ackedAt ??= new Date().toISOString();
      return text("Wake acknowledged. Connection test complete for this agent.");
    }
    default:
      return null;
  }
}

function handleRpc(store, agent, msg) {
  const s = store.agentState(agent.handle);
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  s.methods[msg.method] = (s.methods[msg.method] || 0) + 1;
  const isNotification = msg.id === undefined;
  if (isNotification) return null;
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      s.protocolVersion = requested || null;
      s.clientInfo = msg.params?.clientInfo || null;
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-probe", version: SERVER_VERSION },
        instructions:
          "This is a connection test. Call probe_whoami, then probe_echo, then probe_report. " +
          "If you can be woken by HTTP, call probe_register_wake. When woken with a nonce, call probe_ack.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      s.tools[name] = (s.tools[name] || 0) + 1;
      const result = callTool(store, agent, name, msg.params?.arguments || {});
      if (!result) return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      return reply(result);
    }
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

// ---------------------------------------------------------------- wake

export async function sendWake(store, handle, fetchImpl = fetch) {
  const agent = store.agentByHandle(handle);
  if (!agent) throw new Error("unknown agent");
  const s = store.agentState(handle);
  if (!s.wake?.url) throw new Error("no wake URL registered");
  const nonce = token(9);
  const test = { nonce, sentAt: new Date().toISOString(), status: null, error: null, ackedAt: null };
  s.wakeTests.push(test);
  s.wakeTests = s.wakeTests.slice(-10);
  const body = {
    type: "agent_probe.wake",
    handle,
    nonce,
    instruction: `Agent probe wake test. Call the probe_ack tool on your agent-probe MCP connection with nonce "${nonce}".`,
    sentAt: test.sentAt,
  };
  const headers = { "content-type": "application/json", "user-agent": `agent-probe/${SERVER_VERSION}` };
  if (s.wake.headerName && s.wake.headerValue) headers[s.wake.headerName] = s.wake.headerValue;
  try {
    const res = await fetchImpl(s.wake.url, { method: "POST", redirect: "error", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    test.status = res.status;
  } catch (err) {
    test.error = String(err?.message || err).slice(0, 300);
  }
  store.log({ kind: "wake", handle, nonce, status: test.status, error: test.error });
  store.save();
  return test;
}

// ---------------------------------------------------------------- HTTP

const MAX_BODY = 1_000_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body, headers = {}) {
  const isString = typeof body === "string";
  res.writeHead(status, {
    "content-type": isString ? "text/html; charset=utf-8" : "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    ...headers,
  });
  res.end(body === undefined ? "" : isString ? body : JSON.stringify(body));
}

function touch(store, agent, req) {
  const s = store.agentState(agent.handle);
  const now = new Date().toISOString();
  s.firstSeenAt ??= now;
  s.lastSeenAt = now;
  s.httpHits += 1;
  const ua = String(req.headers["user-agent"] || "(none)").slice(0, 200);
  if (!s.userAgents.includes(ua)) s.userAgents = [...s.userAgents, ua].slice(-5);
  return s;
}

function agentPrompt(agent, origin) {
  const url = `${origin}/mcp/${agent.token}`;
  return [
    `Please run a connection test for me.`,
    ``,
    `1. Add a custom MCP server (connector/plugin) named "agent-probe" with this URL: ${url}`,
    `   It uses Streamable HTTP and needs no sign-in. Treat the URL as a secret.`,
    `2. Call probe_whoami, then probe_echo with any message.`,
    `3. Call probe_report and describe your real capabilities, especially how you can be woken by an HTTP request.`,
    `4. If you have an HTTPS URL that wakes you (webhook, callback or event endpoint), call probe_register_wake with it. Do not include secret keys.`,
    `5. Later you may receive a wake message containing a nonce. When you do, call probe_ack with that nonce.`,
    ``,
    `Tell me which steps worked and exactly where anything failed.`,
  ].join("\n");
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function dashboardHtml(store, admin, origin) {
  const rows = resultsFor(store);
  const mark = (v) => (v ? "✅" : "·");
  const agentRows = rows
    .map((r) => {
      const agent = store.agentByHandle(r.handle);
      const s = store.agentState(r.handle);
      return `<tr>
        <td><b>@${esc(r.handle)}</b><br><small>${esc(r.name)}</small></td>
        <td>${mark(r.reached)}</td><td>${mark(r.oauthDiscoveryAttempted)}</td><td>${mark(r.initialize)}</td>
        <td>${mark(r.toolsList)}</td><td>${mark(r.echoRoundTrip)}</td><td>${mark(r.selfReport)}</td>
        <td>${mark(r.wakeRegistered)}</td><td>${mark(r.wakeDelivered)}</td>
        <td>${r.wakeAcked ? `✅ ${r.wakeLatencySeconds}s` : "·"}</td>
        <td><small>${esc(r.lastSeenAt || "never")}<br>${esc(r.userAgents.join(" | "))}</small></td>
        <td>
          <details><summary>Setup prompt</summary><textarea readonly rows="12" cols="60">${esc(agentPrompt(agent, origin))}</textarea></details>
          <details><summary>Wake config</summary>
            <form method="post" action="/admin/wake-config/${esc(r.handle)}?admin=${esc(admin)}">
              <input name="url" placeholder="https://… wake URL" size="40" value="${esc(s.wake?.url || "")}"><br>
              <input name="headerName" placeholder="Header name (optional)" value="${esc(s.wake?.headerName || "")}">
              <input name="headerValue" type="password" placeholder="${s.wake?.headerValue ? "(saved — leave blank to keep)" : "Header value (optional)"}"><br>
              <button>Save</button>
            </form>
            <form method="post" action="/admin/wake/${esc(r.handle)}?admin=${esc(admin)}"><button ${r.wakeRegistered ? "" : "disabled"}>Send test wake</button></form>
            <small>Last: ${esc(r.lastWake ? `${r.lastWake.status ?? r.lastWake.error} at ${r.lastWake.sentAt}` : "none")}</small>
          </details>
          ${r.selfReport ? `<details><summary>Self-report</summary><pre>${esc(JSON.stringify(r.selfReport, null, 2))}</pre></details>` : ""}
        </td></tr>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Probe</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#fafaf9;--muted:#a8a29e;--line:#44403c;--card:#292524}}
body{font:14px/1.4 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:16px}
table{border-collapse:collapse;width:100%;background:var(--card)}th,td{border:1px solid var(--line);padding:6px;vertical-align:top;text-align:left}
th{font-size:12px;color:var(--muted)}small{color:var(--muted)}textarea,input{font:12px monospace;max-width:100%}
.wrap{overflow-x:auto}
</style></head><body>
<h1>Agent Probe</h1>
<p>Public URL: <code>${esc(origin)}</code>${origin.startsWith("http://") ? " <b>(not HTTPS: cloud agents cannot reach this; use the tunnel URL)</b>" : ""} · <a href="/admin/results.json?admin=${esc(admin)}">results.json</a> · <a href="/admin/results.md?admin=${esc(admin)}">results.md</a> · auto-refreshes every 10s</p>
<div class="wrap"><table><tr><th>Agent</th><th>Reached</th><th>OAuth probe</th><th>initialize</th><th>tools/list</th><th>Echo</th><th>Report</th><th>Wake URL</th><th>Wake 2xx</th><th>Wake ack</th><th>Last seen · User-Agent</th><th>Actions</th></tr>${agentRows}</table></div>
<form method="post" action="/admin/agents?admin=${esc(admin)}" style="margin-top:12px">Add agent: <input name="handle" placeholder="handle e.g. grok-news"> <input name="name" placeholder="display name"> <button>Add</button></form>
<script>setTimeout(()=>{if(!document.querySelector('details[open]')&&document.activeElement.tagName!=='INPUT')location.reload()},10000)</script>
</body></html>`;
}

export function resultsMarkdown(store, origin = PUBLIC_URL) {
  const rows = resultsFor(store);
  const yn = (v) => (v ? "yes" : "no");
  const lines = [
    `# Agent connection test results`,
    ``,
    `Generated ${new Date().toISOString()} from ${origin}`,
    ``,
    `| Agent | Reached | initialize | tools/list | Echo | Self-report | Wake URL | Wake delivered | Wake acked | User-Agent |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...rows.map((r) => `| @${r.handle} | ${yn(r.reached)} | ${yn(r.initialize)} | ${yn(r.toolsList)} | ${yn(r.echoRoundTrip)} | ${yn(r.selfReport)} | ${yn(r.wakeRegistered)} | ${yn(r.wakeDelivered)} | ${r.wakeAcked ? `yes (${r.wakeLatencySeconds}s)` : "no"} | ${(r.userAgents[0] || "").replace(/\|/g, "/")} |`),
    ``,
    `## Self-reports`,
    ...rows.filter((r) => r.selfReport).flatMap((r) => [``, `### @${r.handle}`, "```json", JSON.stringify(r.selfReport, null, 2), "```"]),
  ];
  return lines.join("\n") + "\n";
}

export function createServer(store, { fetchImpl = fetch } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const isAdmin = url.searchParams.get("admin") === store.config.adminToken;
    const origin = PUBLIC_URL || `${String(req.headers["x-forwarded-proto"] || "http").split(",")[0]}://${req.headers.host}`;
    try {
      if (req.method === "OPTIONS") return send(res, 204);

      // OAuth discovery probes: record that the client tried, then say "no auth".
      if (parts[0] === ".well-known") {
        const t = parts.at(-1);
        const agent = store.agentByToken(t);
        if (agent) {
          touch(store, agent, req).oauthDiscovery = true;
          store.save();
        }
        store.log({ kind: "discovery", path: url.pathname.replace(/[A-Za-z0-9_-]{20,}/g, "<token>"), ua: req.headers["user-agent"] });
        return send(res, 404, { error: "not_found", message: "This MCP server requires no authorization." });
      }

      if (parts[0] === "mcp") {
        const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        const agent = store.agentByToken(parts[1]) || store.agentByToken(bearer);
        if (!agent) {
          store.log({ kind: "unauthorized", ua: req.headers["user-agent"] });
          return send(res, 404, { error: "unknown_probe_url" });
        }
        touch(store, agent, req);
        if (req.method === "GET" || req.method === "DELETE") {
          store.save();
          return send(res, 405, { error: "method_not_allowed", message: "Stateless server: use POST." }, { allow: "POST" });
        }
        if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          store.save();
          return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        }
        const batch = Array.isArray(payload);
        const replies = (batch ? payload : [payload]).map((m) => handleRpc(store, agent, m)).filter(Boolean);
        store.log({ kind: "mcp", handle: agent.handle, methods: (batch ? payload : [payload]).map((m) => m?.method === "tools/call" ? `tools/call:${m.params?.name}` : m?.method) });
        store.save();
        if (replies.length === 0) return send(res, 202);
        return send(res, 200, batch ? replies : replies[0]);
      }

      if (parts[0] === "health") return send(res, 200, { ok: true, version: SERVER_VERSION });

      if (!isAdmin) {
        return send(res, 404, `<!doctype html><title>Agent Probe</title><p>Agent probe is running. Open the dashboard with <code>?admin=…</code>.</p>`);
      }

      const admin = store.config.adminToken;
      const back = () => send(res, 303, "", { location: `/?admin=${admin}` });
      const form = async () => Object.fromEntries(new URLSearchParams(await readBody(req)));

      if (req.method === "GET" && url.pathname === "/") return send(res, 200, dashboardHtml(store, admin, origin));
      if (req.method === "GET" && url.pathname === "/admin/results.json") return send(res, 200, resultsFor(store));
      if (req.method === "GET" && url.pathname === "/admin/results.md") {
        return send(res, 200, resultsMarkdown(store, origin), { "content-type": "text/markdown; charset=utf-8" });
      }
      if (req.method === "GET" && url.pathname === "/admin/prompts.json") {
        return send(res, 200, store.config.agents.map((a) => ({ handle: a.handle, url: `${origin}/mcp/${a.token}`, prompt: agentPrompt(a, origin) })));
      }
      if (req.method === "POST" && parts[0] === "admin" && parts[1] === "wake-config" && parts[2]) {
        const agent = store.agentByHandle(parts[2]);
        if (!agent) return send(res, 404, { error: "unknown agent" });
        const f = await form();
        const s = store.agentState(agent.handle);
        const wakeUrl = f.url ? validUrl(f.url) : null;
        if (f.url && !wakeUrl) return send(res, 400, { error: "wake URL must be https (http only for localhost)" });
        s.wake = {
          ...(s.wake || {}),
          url: wakeUrl,
          headerName: f.headerName || null,
          headerValue: f.headerValue ? f.headerValue : s.wake?.headerValue || null,
          registeredBy: "operator",
          registeredAt: new Date().toISOString(),
        };
        if (!f.headerName) s.wake.headerValue = null;
        store.save();
        return back();
      }
      if (req.method === "POST" && parts[0] === "admin" && parts[1] === "wake" && parts[2]) {
        await sendWake(store, parts[2], fetchImpl);
        return back();
      }
      if (req.method === "POST" && url.pathname === "/admin/agents") {
        const f = await form();
        store.addAgent(String(f.handle || "").trim(), String(f.name || "").trim());
        return back();
      }
      return send(res, 404, { error: "not_found" });
    } catch (err) {
      return send(res, 500, { error: String(err?.message || err) });
    }
  });
}

// ---------------------------------------------------------------- main

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = createStore();
  const server = createServer(store);
  server.listen(PORT, () => {
    console.log(`\nAgent probe listening on port ${PORT}`);
    const base = PUBLIC_URL || `http://localhost:${PORT}`;
    console.log(`Local:       http://localhost:${PORT}`);
    console.log(`Dashboard:   ${base}/?admin=${store.config.adminToken}`);
    console.log(`             (open it through your tunnel URL and the setup prompts use that URL)\n`);
    console.log(`Per-agent MCP URLs (treat as secrets):`);
    for (const a of store.config.agents) console.log(`  @${a.handle.padEnd(10)} ${base}/mcp/${a.token}`);
    console.log(`\nData: ${DATA_DIR}`);
  });
}
