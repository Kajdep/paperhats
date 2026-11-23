import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createStore, createServer, resultsFor, resultsMarkdown } from "./server.mjs";

async function start(fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-probe-"));
  const store = createStore(dir);
  const server = createServer(store, fetchImpl ? { fetchImpl } : {});
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, server, base, dir };
}

const rpc = (base, tokenPath, body, headers = {}) =>
  fetch(`${base}/mcp/${tokenPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "test-agent/1.0", ...headers },
    body: JSON.stringify(body),
  });

test("full MCP handshake, tools and self-report are recorded per agent", async (t) => {
  const { store, server, base } = await start();
  t.after(() => server.close());
  const grok = store.agentByHandle("grok-bot");

  const init = await rpc(base, grok.token, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grok", version: "1" } },
  });
  assert.equal(init.status, 200);
  const initBody = await init.json();
  assert.equal(initBody.result.protocolVersion, "2025-06-18");
  assert.equal(initBody.result.serverInfo.name, "agent-probe");

  const notif = await rpc(base, grok.token, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notif.status, 202);

  const list = await (await rpc(base, grok.token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.deepEqual(list.result.tools.map((x) => x.name), ["probe_whoami", "probe_echo", "probe_report", "probe_register_wake", "probe_ack"]);

  const who = await (await rpc(base, grok.token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "probe_whoami", arguments: {} } })).json();
  assert.match(who.result.content[0].text, /"handle": "grok-bot"/);

  const echo = await (await rpc(base, grok.token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "probe_echo", arguments: { message: "hi" } } })).json();
  assert.match(echo.result.content[0].text, /"echo": "hi"/);

  await rpc(base, grok.token, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "probe_report", arguments: { agent_product: "Grok Bot", can_be_woken_by_http: "yes" } } });

  const r = resultsFor(store).find((x) => x.handle === "grok-bot");
  assert.equal(r.reached, true);
  assert.equal(r.initialize, true);
  assert.equal(r.toolsList, true);
  assert.equal(r.echoRoundTrip, true);
  assert.equal(r.selfReport.agent_product, "Grok Bot");
  assert.deepEqual(r.clientInfo, { name: "grok", version: "1" });
  assert.deepEqual(r.userAgents, ["test-agent/1.0"]);

  // Other agents stay untouched: identity comes from the URL.
  assert.equal(resultsFor(store).find((x) => x.handle === "dot").reached, false);
  assert.match(resultsMarkdown(store), /\| @grok-bot \| yes \| yes \| yes \| yes \| yes \|/);
});

test("bearer token works on /mcp and unknown tokens are rejected", async (t) => {
  const { store, server, base } = await start();
  t.after(() => server.close());
  const dot = store.agentByHandle("dot");
  const ok = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${dot.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(ok.status, 200);
  const bad = await rpc(base, "not-a-token", { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(bad.status, 404);
  const get = await fetch(`${base}/mcp/${dot.token}`);
  assert.equal(get.status, 405);
});

test("OAuth discovery attempts are recorded and answered with 404", async (t) => {
  const { store, server, base } = await start();
  t.after(() => server.close());
  const muse = store.agentByHandle("muse");
  const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp/${muse.token}`);
  assert.equal(res.status, 404);
  assert.equal(resultsFor(store).find((x) => x.handle === "muse").oauthDiscoveryAttempted, true);
});

test("wake round trip: register, operator adds key, wake delivered, agent acks nonce", async (t) => {
  let received;
  const hook = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    received = { headers: req.headers, body: JSON.parse(body) };
    res.writeHead(200).end("ok");
  });
  await new Promise((r) => hook.listen(0, r));
  const hookUrl = `http://localhost:${hook.address().port}/wake`;
  const { store, server, base } = await start();
  t.after(() => { server.close(); hook.close(); });
  const hermes = store.agentByHandle("hermes");
  const admin = store.config.adminToken;

  const reg = await (await rpc(base, hermes.token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe_register_wake", arguments: { url: hookUrl } } })).json();
  assert.equal(reg.result.isError, undefined);

  const bad = await (await rpc(base, hermes.token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "probe_register_wake", arguments: { url: "http://evil.example/x" } } })).json();
  assert.equal(bad.result.isError, true);

  const cfg = await fetch(`${base}/admin/wake-config/hermes?admin=${admin}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ url: hookUrl, headerName: "x-routine-key", headerValue: "s3cret" }),
  });
  assert.equal(cfg.status, 303);

  const wake = await fetch(`${base}/admin/wake/hermes?admin=${admin}`, { method: "POST", redirect: "manual" });
  assert.equal(wake.status, 303);
  assert.equal(received.headers["x-routine-key"], "s3cret");
  assert.equal(received.body.type, "agent_probe.wake");

  const ack = await (await rpc(base, hermes.token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "probe_ack", arguments: { nonce: received.body.nonce } } })).json();
  assert.match(ack.result.content[0].text, /acknowledged/);

  const r = resultsFor(store).find((x) => x.handle === "hermes");
  assert.equal(r.wakeRegistered, true);
  assert.equal(r.wakeDelivered, true);
  assert.equal(r.wakeAcked, true);
  // The secret header value is never included in results.
  assert.doesNotMatch(JSON.stringify(resultsFor(store)), /s3cret/);
});

test("dashboard and admin endpoints require the admin token", async (t) => {
  const { store, server, base } = await start();
  t.after(() => server.close());
  assert.equal((await fetch(`${base}/admin/results.json`)).status, 404);
  const ok = await fetch(`${base}/?admin=${store.config.adminToken}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Agent Probe/);
});
