# Agent connection probe

Phase 0 of the lightweight agent hub: before building anything, find out what each
personal agent can **actually** do.

It answers four questions for every agent:

| Question | How the probe answers it |
| --- | --- |
| Can it reach a custom MCP server? | Any request to its secret URL is recorded (with the User-Agent). |
| Does it speak MCP properly? | `initialize`, `tools/list` and tool calls are recorded. |
| What does it say it can do? | The agent calls `probe_report` and describes itself. |
| Can something outside wake it? | The operator sends a test wake. The agent must call `probe_ack` with the nonce. |

Everything is local: one Node file, no dependencies, data in `agent-probe/data/` (gitignored).

## Files

| File | What it is |
| --- | --- |
| `scan-agents.ps1` | Read-only Windows scan for installed agents, local LLM runtimes, models, MCP configs, ports and tunnels. Writes `agent-scan.json`. |
| `start-probe.ps1` | Starts the probe plus a free Cloudflare HTTPS tunnel and opens the dashboard. |
| `server.mjs` | The probe: a stateless Streamable HTTP MCP server with one secret URL per agent, a dashboard and a results export. |
| `server.test.mjs` | Tests (`node --test`). |

## Run it on your PC

Needs Node.js 22+ (`winget install OpenJS.NodeJS.LTS`). For cloud agents you also need
`cloudflared` (`winget install Cloudflare.cloudflared`). The quick tunnel needs no account.

```powershell
cd D:\path\to\paperhats\agent-probe
powershell -ExecutionPolicy Bypass -File .\scan-agents.ps1
```

```powershell
powershell -ExecutionPolicy Bypass -File .\start-probe.ps1
```

The launcher prints one MCP URL per agent and opens the dashboard. Each row in the
dashboard has a **Setup prompt** with that agent's URL already filled in.

> The quick-tunnel URL changes every time you restart it. Finish a test round in one
> sitting, or re-paste the URLs after a restart. The per-agent tokens stay the same.

## Test each agent

For every agent: paste its **Setup prompt** into the agent, then watch its row turn green.

| Agent | Where to add the MCP URL | Wake test |
| --- | --- | --- |
| **Hermes Agent** | `~/.hermes/config.yaml` (see below), then `/reload-mcp`. Use the `localhost` URL if Hermes runs on this PC or in WSL. | Use the Hermes gateway (Telegram/Discord/…) or its API server, if enabled, as the wake URL. |
| **OpenClaw** | Paste the setup prompt and let OpenClaw add the MCP server, or add it in its MCP settings. | Gateway webhook, if one is configured. |
| **Grok Bot** | Team Bot or Marketplace settings → custom remote MCP (HTTPS tunnel URL only). | Create a **webhook-only routine** with no schedule, then open its **Webhook** panel. In the probe dashboard's **Wake config**, enter the routine URL, header name `Authorization` and value `Bearer <routine key>`. Keep the key out of the chat. |
| **OpenAI Dot** | ChatGPT **Developer mode** → custom MCP plugin (HTTPS tunnel URL). Attach the plugin to the Dot conversation if its tools don't appear. | Dot wakes on MCP Events subscriptions, which the probe doesn't emulate. Record whether Dot offers a callback URL via `probe_register_wake`. |
| **Meta Muse** | Ask Muse to add a connector with the HTTPS tunnel URL (streamable HTTP). Approve the hostname in Muse's permission UI. | Muse managed hooks: record what Muse reports in `probe_report`. |
| **Manus Cue** | Manus → Connectors → **Custom MCP** by URL (HTTPS tunnel URL). | Unknown: this test is how we find out. |

To test several bots on one platform (for example 10 Grok Bots), use **Add agent** on the
dashboard so each one gets its own URL. Grok plugins are account-wide, so the URL is what
keeps the bots apart.

### Hermes config snippet

```yaml
mcp_servers:
  agent-probe:
    url: "http://localhost:8787/mcp/<hermes token from the launcher>"
```

## Results

- Dashboard: `<public URL>/?admin=<admin token>`
- Markdown table: `<public URL>/admin/results.md?admin=<admin token>`
- JSON: `<public URL>/admin/results.json?admin=<admin token>`
- Raw log: `agent-probe/data/events.jsonl` (tokens are never logged)

Send the markdown results back (or `agent-scan.json`) and we will pick the wake adapters
for the hub from what actually worked.

## Security notes

- Every agent URL and the admin token are secrets. Anyone holding an agent URL can act as that agent **on the probe only**. The probe has no access to anything else.
- `data/config.json` and `data/state.json` hold the tokens and wake keys. They are created owner-only (on Windows, keep `agent-probe\data` inside your user profile or another private folder).
- The launcher prints the URLs to the console only. It sets `PROBE_QUIET_SECRETS=1`, so `data/server.log` contains no tokens. Do not redirect or transcript the launcher window.
- Wake headers you enter in the dashboard are never shown in the results.
- Wake URLs registered by agents must be HTTPS (plain HTTP only for localhost), and wakes are only sent when you click **Send test wake**.
- Stop the tunnel (Ctrl+C) when you are done. The probe is a test tool, not the hub.

## Develop

```sh
cd agent-probe
node --test server.test.mjs
PORT=8787 node server.mjs
```
