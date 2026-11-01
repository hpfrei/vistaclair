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

### Prerequisites

- **Node.js** — 18+ for the free core, **22.12+ for vistaclair Pro** (its `puppeteer@25` dependency needs it). Node 22 LTS is recommended. Distro packages are often too old (Debian 12 ships Node 18, Debian 13 ships Node 20), so on Debian/Ubuntu use NodeSource:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
  ```
  Or use [nvm](https://github.com/nvm-sh/nvm): `nvm install 22`.
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** — must be on your `PATH`, vistaclair runs the `claude` it finds there:
  ```bash
  curl -fsSL https://claude.ai/install.sh | bash   # or: npm install -g @anthropic-ai/claude-code
  claude --version
  ```
  No need to sign in beforehand — the sign-in pill in the dashboard header runs `claude auth login`.
- **git**, plus a C/C++ toolchain for the in-browser terminal (optional dependency `node-pty`; without it the terminal falls back to one command at a time): `sudo apt install -y git build-essential python3`

Then install:

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
| `VISTACLAIR_CSP` | on | `off` drops the dashboard's Content-Security-Policy header (emergency off-switch), `report-only` sends it as `Content-Security-Policy-Report-Only`; see [SECURITY.md](SECURITY.md#content-security-policy) |

> [!WARNING]
> The dashboard binds to `0.0.0.0` for remote access. It is protected by the auth token, but do not expose it to untrusted networks without TLS/VPN.

### Dashboard login

The auth token is always a login, from the host itself or from anywhere else (including through a reverse proxy or tunnel): enter it on the login page, or send it as a `token` cookie or an `Authorization: Bearer` header. Locally started servers open the dashboard already signed in (`/login/auto`, host-only).

**One-time login link** — `vistaclair login-link` (run on the host while the server is running) prints a URL that signs a browser in once, without the token: valid 5 minutes, single use. Replace `localhost` with your public dashboard address to use it from another device.

Other login methods come from add-ons, such as Vistaclair Pro's "scan a QR code, approve in Telegram". Core provides the mechanism: the login page asks for a challenge (`POST /login/challenge/start`) — a short code, plus a QR code for each login provider an add-on registered — and waits (`POST /login/challenge/poll`) until the provider approves or denies the code out of band; an approved challenge becomes a dashboard session. Add-ons use `ctx.login`: `registerProvider({ id, label, link(code) })`, `describe(code)`, `approve(code, { via, who })`, `deny(code)`, `listSessions()`, `revokeSession(id)`, `revokeAll()` and `onLogin(fn)`, documented in `src/addon-host.js`.

Sessions (from login links and challenges) last 30 days, survive restarts (`sessions.json` in the data home stores only hashes of the session cookies) and are listed on the Security page, with how each signed in, where it can be revoked.

### Supervisor and rescue page

`npm start`, `npm run dev` and `vistaclair` run `bin/supervisor.js`, which starts `server.js` as a child process (`node server.js` still runs unwrapped; server mode, `VISTACLAIR_SERVER=1`, is never wrapped). The supervisor keeps one auth token for every restart, so the header's **Restart** button gives you a fresh server process under the same login. Server output is echoed to the terminal and appended to `data/logs/server.log` under the data home.

If the server cannot come back — it exits during startup, does not answer `/api/ping` within `VISTACLAIR_BOOT_TIMEOUT_MS` (default 120 s), crashes 3 times within a minute, or stops answering pings while running for `VISTACLAIR_HANG_TIMEOUT_MS` (default 180 s) — the supervisor stops it and serves a **rescue page** on the dashboard port itself: the reason, the log tail, a shell in the browser (your login shell in the install directory; one-command-at-a-time if `node-pty` is unavailable) and a **Retry start** button. Fix the problem in the shell (e.g. `git revert`, `npm install`) and press Retry; the page switches to the dashboard once it answers.

The rescue page asks for the same credentials as the dashboard: the auth token, or a dashboard session already in your browser. Ctrl-C stops the supervisor and the server.

### Claude subscription and terms

vistaclair runs on your own machine with your own Claude credential: each user signs in to Claude Code with their own Claude account, or adds their own Anthropic API key. Usage is under Anthropic's terms — see [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) and [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance). vistaclair never reads or stores your Claude login: sign-in runs Claude Code's own `claude auth login`, and Claude Code's requests pass through the local inspector proxy to Anthropic without vistaclair touching their credentials (the inspector redacts `Authorization` / `x-api-key` and does not write request headers to the saved interactions).

**Sign in to Claude** — the pill in the header shows whether Claude Code is signed in (plan and email, from `claude auth status`) and opens a sign-in window when it isn't. It runs `claude auth login` in a small terminal: open the sign-in page it prints, sign in on Anthropic's site, and paste the code it shows if asked. The window also opens by itself when a session's Claude login is refused, so you never need a terminal to sign in again.

---

## What it does

**Inspector** — Full request/response capture across all sessions. System prompts, message history, tool definitions, tool call inputs/outputs (JSON tree), thinking blocks, SSE event stream, cURL export. Token breakdown (input, output, cache read/create, reasoning) and cost tracking per turn, per group, per session. Subagent tracking with color-coded parallel swimlane view. Hook events nested under the turns that triggered them. All interactions saved to disk as JSON.

**CLI** — Multi-tab Claude Code terminal in the browser. Per-session model routing, directory spawning, session save/resume. **Paste screenshots from clipboard or drag-drop files directly into a session** — works over a tunnel from any device. AskUserQuestion appears inline — answer from any browser and Claude continues. Forms can show pictures: options with an `image` become a thumbnail grid to pick from, and a question's `images` are shown for the user to comment on (local paths, paths relative to the session's directory, URLs or data URIs; a zoom button opens each one large).

**Agent SDK sessions** — From the CLI tab's `+` menu, **New CLI in directory…** asks for the session type and opens a session or an orchestrator run on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), in an HTML panel. The terminal engine stays as a fallback: the ⚙ menu on the CLI tab strip has **Use the terminal engine for new sessions** (off by default), for the case where Agent SDK use on subscriptions becomes restricted; open terminal tabs and their resumes keep working either way. The same dialog (also used by Pro's Change app) asks whether to bill it to your Claude subscription (the default) or your Anthropic API key (added on the Models page) when both are set up, and otherwise names the one in use; for an orchestrator, its own model (Opus or Fable, 1M context). A collapsed, off-by-default **Route to other models** section can send a model family (fable, opus, sonnet, haiku) to any usable model from the Models page, for the whole session or run — orchestrator, workers and subagents — through the proxy; it warns when the target bills per token elsewhere or has a smaller context. A run is drawn as a diagram: the orchestrator box on top, its workers in a row below, joined by lines that flash when they message each other. Each box carries its name, model, state and cost on its border, with the main agent's context use (% of the window, warmer as it nears auto-compaction) beside the Inspector button, and a toggle between Live — its TODO on top and, below a movable divider, its text and the description of each tool call, subagents' included under numbered chips (Explore 1, Explore 2, …) — and its NOTES; the Inspector button opens the full stream with thinking and tool calls. Clicking the model switches the live session to another model, keeping its context and cost. One composer at the bottom takes text and pasted or attached images; on send it asks which session the message is for, then for a confirmation. The orchestrator can start each worker on `fable`, `opus`, `sonnet` or `haiku`. A run has at most 5 workers at once: a `launch_cli` beyond that is queued in the run and starts by itself when a slot frees, oldest first (`after: [worker]` holds it until those workers have landed, or, without a worktree, reported done), and a finished worker whose branch landed and whose worktree is clean may be closed automatically to make room; `cancel_launch` drops a queued launch, `end_run` drops them all, and nothing starts while the run is paused.

**Worktree landing** — In a git repo, each worker of an orchestrator run works in its own worktree on branch `orch/<run>/<worker>` and commits there. Its `done` report lands the branch, by code: rebased onto the base branch recorded at launch, the repo's check run, merged with `--no-ff` (`Merge orch/<run>/<worker>: <summary>`). Uncommitted changes, a conflict (rebase aborted, base untouched) or a failing check go back to the worker; the owner's uncommitted changes to files the merge touches stop it with nothing changed. `launch_cli` takes an optional `area` (repo-relative paths or globs): an overlap with a running worker's area in the same repo is named in the launch result, and every few minutes a file changed (committed or not) in two live worktrees of one repo is told to both workers (keep the change minimal, expect to rebase) and noted for the orchestrator once per file and worker pair. A worker's `done` report and its landing reach the orchestrator as one event (`reported done: … — landed <sha>`, naming running workers that change the same files, or `— not landed: <reason>`); `started` and progress reports and overlap notes do not wake an idle orchestrator but come with its next delivery (or after 10 minutes at the latest). A landing cut off by a restart after its merge commit is recorded as landed; messages queued for a busy session survive a restart. Each landing is recorded in the run; the orchestrator's `undo_landing` reverts one with a new commit. A closed or exited worker's worktree, and `end_run`'s, is removed once its branch is merged and nothing uncommitted is left (`git worktree remove` and `git branch -d`, never forced); otherwise it is kept, with the reason and files. A versioned `.vistaclair-worktree.json` (nearest from the worker's directory up to the repo root) declares gitignored paths to symlink (`links`) or copy (`copy`: a private copy for the worker, e.g. an untracked `.settings.json`, so it cannot change the main checkout's file) from the main checkout into each worktree and an optional check, e.g. `{ "links": [".data", "node_modules", ".venv"], "copy": [".settings.json"], "check": "npm test" }`; both are relative to the file, recorded in the run, excluded from git, never counted as changes or committed, and removed at teardown (links unlinked, their targets untouched; a copy that differs from the original is only logged). A landing reads the manifest as committed on the base branch (the working file only when it is untracked there), so the owner's half-edited copy changes nothing; a manifest that is not valid JSON refuses the landing as `manifest-unreadable` (the file and the JSON error go to the orchestrator, or the toast of an isolated CLI session), never lands it unchecked. A session's card also names, in one sentence, the gitignored entries of the main checkout that its worktree lacks (build output and caches left out, at most 10), to be added to `links` or `copy`.

**Owner checklist** — What only the owner can do (Stop→Start, Build, Make live, Rebuild client, an approval) or decide goes into a worker's `report` as `ownerItems` (`what`, `why`, `kind` action or decision, `options`, `recommended`, `key`) and lands on one "your turn" checklist, saved in the run: an open item with the same `key` (or the same `what`) is updated, not repeated, and a resolved one comes back only with a different `why`. The orchestrator keeps it right with `owner_items` (list, add, resolve, drop, reorder); blocking items come first, then the oldest. The Sessions tab lists every run's open items above the cards, and an orchestrator tab has a **Your turn** button with its own: tick an action, pick or type an answer for a decision, or drop an item. The orchestrator is woken by the owner's answer and the proposing worker, if running, is told. Next to it, a read-only panel shows who holds and who waits for the machine-wide resource locks (`GET /api/locks`). The list only records; it does not run Build or Make live.
**Isolated simple CLI** — A simple (non-orchestrator) session can opt into the same isolation: "Own git worktree" in the new-CLI directory picker, or `isolation: "worktree"` on `cli:open` / `openCli`. It then works in `data/worktrees/cli/<id>` on branch `cli/<id>` from the main checkout's branch (its base), with the declared links. The ⤵ button on its tab, `cli:land`, or `POST /api/cli-isolation/land` `{ tabId | sessId }` lands it like a worker (`Merge cli/<id>: <title>`); the outcome (landed sha, nothing to land, or why not, with the files) is shown as a toast and recorded in the session (`GET /api/cli-isolation/status`). At close or exit it lands first only with "Land on close" (`landOnClose: true`, default off); then its worktree goes when merged and clean, else it is kept with the reason. A shutdown keeps every worktree; a landing cut off by a restart has its rebase aborted and is recorded as interrupted. A resumed session whose worktree went gets it back at the same path.

**Resource locks** — `node bin/vistaclair-lock.js [-s|--shared] [-x|--exclusive] [--timeout <sec>] <name>[,<name>...] -- <command> [args...]` is a machine-wide lock that workers, apps and manual shells share, so nobody needs a private lock file or a hand-over by message. It takes every named lock (exclusive by default; names are `[a-z0-9._-]`, up to 64 characters; several names are taken in sorted order, so callers cannot deadlock each other), runs the command, forwards SIGINT/SIGTERM/SIGHUP to it, releases when it exits and exits with its exit code. "The GPU probe excludes heavy jobs" is expressed by the callers: the probe takes `heavy` exclusive, heavy jobs take `heavy` shared (shared holders coexist, an exclusive one waits for them and they wait for it). The lock is a kernel `flock(1)` held by helper processes that live and die with the wrapper, so a `kill -9` or a server restart releases it; there are no leases and no server round-trip (Linux, needs util-linux `flock`). Waiting is not first-come-first-served: `flock` makes no FIFO promise, and no ticket queue is built on top. While it waits it prints `waiting for <name> (held by <who> since <time>)` to stderr. Landing checks never wait: with `VISTACLAIR_LANDING=1` (set for the repo's check) a busy lock fails at once with exit 75 naming the holder, unless `--timeout` is given (75 also means a timeout ran out). The lock directory is `<data home>/data/locks` (the same from any checkout or worktree; `VISTACLAIR_LOCK_DIR` overrides); holders and waiters leave records there, stale ones (dead pid) are ignored, and `GET /api/locks` returns `{ dir, locks: [{ name, holders: [...], waiters: [...] }] }` for the dashboard.

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

The dashboard's browser libraries (xterm, marked, DOMPurify, d3, Monaco, MathJax) are vendored at pinned versions in [`public/vendor/`](public/vendor/README.md), and every dashboard page is served with a Content-Security-Policy that only runs script from the dashboard itself ([SECURITY.md](SECURITY.md#content-security-policy)).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/request-flow-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/request-flow-light.svg">
  <img alt="Request flow diagram" src="docs/request-flow-light.svg" width="880">
</picture>

---

## License

**Apache 2.0** — see [LICENSE](LICENSE). Copyright 2026 [hpfreilabs.com](https://hpfreilabs.com)

Everything above is free and open source. **vistaclair Pro** adds the Apps Platform as a separately licensed commercial add-on. [Learn more →](https://hpfreilabs.com/vistaclair/)
