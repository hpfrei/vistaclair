<div align="center">

<img src="public/favicon.svg" width="80" alt="vistaclair logo"/>

# vistaclair

**Agent inspector, control room, and transparent proxy for Claude Code.**

[![npm](https://img.shields.io/npm/v/vistaclair)](https://www.npmjs.com/package/vistaclair)
[![downloads](https://img.shields.io/npm/dm/vistaclair)](https://www.npmjs.com/package/vistaclair)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

</div>

```bash
npx vistaclair
```

I built this because I wanted to see what Claude Code actually sends to the LLM — the full requests, tool calls, hooks, subagent threads, token counts. The Inspector shows all of it on the wire, in real time, across sessions. From there it grew into a full control surface: multi-tab CLI sessions I can steer from a phone over a tunnel, proxy rules that rewrite or reroute requests to OpenAI/Gemini/DeepSeek/Ollama before they hit the API, and an integrated MCP server for custom tools. I use it daily.

<div align="center">

https://github.com/user-attachments/assets/3d82bb12-87e1-4e20-aa98-52d4f3512062

<img src="docs/vistaclair-poster.png" alt="vistaclair demo" width="880">

</div>

---

## Getting started

**Requires:** Node.js 18+ and [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (authenticated).

```bash
npm install -g vistaclair
vistaclair
```

Or clone:

```bash
git clone https://github.com/hpfrei/vistaclair.git
cd vistaclair && npm install && npm start
```

Open **http://localhost:3457** and log in with the auth token printed to the console.

> [!TIP]
> **Use Claude through the proxy** — run this in any terminal to route all traffic through vistaclair:
> ```bash
> ANTHROPIC_BASE_URL=http://localhost:3456 claude
> ```
> Works with interactive sessions, `claude -p "prompt"`, and IDE integrations. Traffic appears in the Inspector.

> [!TIP]
> Custom port: `npm start -- 8080` or `DASHBOARD_PORT=8080 npm start`

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AUTH_TOKEN` | auto-generated | Dashboard auth token |
| `PROXY_PORT` | `3456` | API proxy port (localhost only) |
| `DASHBOARD_PORT` | `3457` | Web dashboard port (all interfaces) |
| `ANTHROPIC_TARGET_URL` | `https://api.anthropic.com` | Upstream API URL |
| `MAX_HISTORY` | `200` | Max interactions kept in memory |

> [!WARNING]
> The dashboard binds to `0.0.0.0` for remote access. It is protected by the auth token, but do not expose it to untrusted networks without TLS/VPN.

### Claude subscription and terms

vistaclair runs on your own machine with your own Claude credential: each user signs in to Claude Code with their own Claude account, or adds their own Anthropic API key. Usage is under Anthropic's terms — see [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) and [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance). vistaclair never reads or stores your Claude login: sign-in runs Claude Code's own `claude auth login`, and Claude Code's requests pass through the local inspector proxy to Anthropic without vistaclair touching their credentials (the inspector redacts `Authorization` / `x-api-key` and does not write request headers to the saved interactions).

**Sign in to Claude** — the pill in the header shows whether Claude Code is signed in (plan and email, from `claude auth status`) and opens a sign-in window when it isn't. It runs `claude auth login` in a small terminal: open the sign-in page it prints, sign in on Anthropic's site, and paste the code it shows if asked. The window also opens by itself when a session's Claude login is refused, so you never need a terminal to sign in again.

---

## What it does

**Inspector** — Full request/response capture across all sessions. System prompts, message history, tool definitions, tool call inputs/outputs (JSON tree), thinking blocks, SSE event stream, cURL export. Token breakdown (input, output, cache read/create, reasoning) and cost tracking per turn, per group, per session. Subagent tracking with color-coded parallel swimlane view. Hook events nested under the turns that triggered them. All interactions saved to disk as JSON.

**CLI** — Multi-tab Claude Code terminal in the browser. Per-session model routing, directory spawning, session save/resume. **Paste screenshots from clipboard or drag-drop files directly into a session** — works over a tunnel from any device. AskUserQuestion appears inline — answer from any browser and Claude continues. Forms can show pictures: options with an `image` become a thumbnail grid to pick from, and a question's `images` are shown for the user to comment on (local paths, paths relative to the session's directory, URLs or data URIs; a zoom button opens each one large).

**Agent SDK sessions** — From the CLI tab's `+` menu, **New CLI in directory…** asks for the session type and opens a session or an orchestrator run on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), in an HTML panel. The terminal engine stays as a fallback: the ⚙ menu on the CLI tab strip has **Use the terminal engine for new sessions** (off by default), for the case where Agent SDK use on subscriptions becomes restricted; open terminal tabs and their resumes keep working either way. The same dialog (also used by Pro's Change app) asks whether to bill it to your Claude subscription (the default) or your Anthropic API key (added on the Models page) when both are set up, and otherwise names the one in use; for an orchestrator, its own model (Opus or Fable, 1M context). A collapsed, off-by-default **Route to other models** section can send a model family (fable, opus, sonnet, haiku) to any usable model from the Models page, for the whole session or run — orchestrator, workers and subagents — through the proxy; it warns when the target bills per token elsewhere or has a smaller context. A run is drawn as a diagram: the orchestrator box on top, its workers in a row below, joined by lines that flash when they message each other. Each box carries its name, model, state and cost on its border, with the main agent's context use (% of the window, warmer as it nears auto-compaction) beside the Inspector button, and a toggle between Live — its TODO on top and, below a movable divider, its text and the description of each tool call, subagents' included under numbered chips (Explore 1, Explore 2, …) — and its NOTES; the Inspector button opens the full stream with thinking and tool calls. Clicking the model switches the live session to another model, keeping its context and cost. One composer at the bottom takes text and pasted or attached images; on send it asks which session the message is for, then for a confirmation. The orchestrator can start each worker on `fable`, `opus`, `sonnet` or `haiku`.

**Provider routing** — Route through Anthropic, OpenAI, Gemini, xAI (Grok), DeepSeek, Kimi, or Ollama. 40+ models pre-configured. The proxy translates Anthropic Messages API to the target format transparently.

**Proxy rules** — JavaScript middleware that intercepts every request. Swap models, strip tools, inject prompts, short-circuit responses. Describe in English, vistaclair generates the JS. Hot-reloaded, toggleable.

**MCP tools** — Define custom tools in the browser with typed parameters and a JS handler. Claude gets the capability instantly. Built-in: `vista-AskUserQuestion` (routes questions to dashboard UI).

**File manager** — Browse, preview, and manage files on the remote machine. Monaco editor, multi-select, integrated shell.

**Skills, agents, hooks** — Create and edit `.claude/` skills, agents, and hooks from the dashboard.

---

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/architecture-light.svg">
  <img alt="vistaclair architecture" src="docs/architecture-light.svg" width="880">
</picture>

Two servers, one process:

| Server | Port | Binding | Purpose |
|---|---|---|---|
| **Proxy** | `:3456` | `127.0.0.1` | Intercepts Claude API calls for inspection and routing |
| **Dashboard** | `:3457` | `0.0.0.0` | Web UI, REST API, WebSocket (auth-protected) |

Every `claude` process gets a unique instance ID in its base URL (`http://localhost:3456/i/{id}`), so concurrent sessions are fully isolated.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/request-flow-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/request-flow-light.svg">
  <img alt="Request flow diagram" src="docs/request-flow-light.svg" width="880">
</picture>

---

## License

**Apache 2.0** — see [LICENSE](LICENSE). Copyright 2026 [hpfreilabs.com](https://hpfreilabs.com)

Everything above is free and open source. **vistaclair Pro** adds the Apps Platform as a separately licensed commercial add-on. [Learn more →](https://hpfreilabs.com/vistaclair/)
