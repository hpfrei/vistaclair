// ============================================================
// HOME VIEW — Overview, Inspector & CLI, Rules, MCP, Connect
// ============================================================
(function homeModule() {
  'use strict';
  const { renderMarkdown } = window.dashboard;

  // --- Sub-tab switching ---
  document.getElementById('homeNav')?.addEventListener('click', e => {
    const btn = e.target.closest('.view-tab');
    if (!btn) return;
    const section = btn.dataset.section;
    document.getElementById('homeNav').querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.home-section').forEach(s => s.classList.remove('active'));
    const target = document.getElementById('home-' + section);
    if (target) target.classList.add('active');
  });

  // --- Content ---

  const overviewMd = `
# vistaclair

Claude Code is just a program that talks to a large language model over HTTP. Every keystroke you give it becomes a request; every edit, plan, and tool call comes back in the reply. Normally that conversation is invisible — it happens between your terminal and the model's API, and you only see the polished result.

**vistaclair sits in the middle of that conversation.** It is a transparent proxy: Claude Code thinks it's talking to the model, the model thinks it's talking to Claude Code, and vistaclair quietly records and (if you want) rewrites everything in between. The result is a browser dashboard where you can *watch the raw traffic*, *change what gets sent*, and *swap which model answers* — without touching Claude Code itself.

\`\`\`svg
<svg viewBox="0 0 780 280" xmlns="http://www.w3.org/2000/svg" style="max-width:780px;font-family:system-ui,sans-serif">
  <defs>
    <marker id="ov1" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker>
  </defs>

  <!-- You -->
  <rect x="15" y="55" width="120" height="95" rx="10" fill="none" stroke="var(--accent)" stroke-width="2"/>
  <text x="75" y="82" text-anchor="middle" fill="var(--text)" font-size="13" font-weight="600">You</text>
  <text x="75" y="100" text-anchor="middle" fill="var(--text-dim)" font-size="10">any browser</text>
  <text x="75" y="116" text-anchor="middle" fill="var(--text-dim)" font-size="9">laptop · phone · tablet</text>
  <text x="75" y="134" text-anchor="middle" fill="var(--text-dim)" font-size="9">or REST API client</text>

  <!-- Tunnel arrow -->
  <line x1="135" y1="100" x2="248" y2="100" stroke="var(--text-dim)" stroke-width="1.5" stroke-dasharray="8,4" marker-end="url(#ov1)"/>
  <text x="192" y="90" text-anchor="middle" fill="var(--text-dim)" font-size="9">tunnel / VPN / LAN</text>

  <!-- vistaclair server -->
  <rect x="250" y="15" width="260" height="180" rx="10" fill="none" stroke="var(--green)" stroke-width="2.5"/>
  <text x="380" y="42" text-anchor="middle" fill="var(--green)" font-size="15" font-weight="700">vistaclair</text>
  <text x="380" y="60" text-anchor="middle" fill="var(--text-dim)" font-size="10">the proxy + dashboard, on your PC</text>

  <rect x="262" y="72" width="115" height="28" rx="5" fill="none" stroke="var(--accent)" stroke-width="1"/>
  <text x="319" y="90" text-anchor="middle" fill="var(--text)" font-size="10">Inspector</text>

  <rect x="385" y="72" width="115" height="28" rx="5" fill="none" stroke="var(--accent)" stroke-width="1"/>
  <text x="442" y="90" text-anchor="middle" fill="var(--text)" font-size="10">Rules</text>

  <rect x="262" y="108" width="115" height="28" rx="5" fill="none" stroke="var(--accent)" stroke-width="1"/>
  <text x="319" y="126" text-anchor="middle" fill="var(--text)" font-size="10">CLI · Directories</text>

  <rect x="385" y="108" width="115" height="28" rx="5" fill="none" stroke="var(--accent)" stroke-width="1"/>
  <text x="442" y="126" text-anchor="middle" fill="var(--text)" font-size="10">MCP tools</text>

  <text x="380" y="182" text-anchor="middle" fill="var(--text-dim)" font-size="9">dashboard :3457  ·  proxy :3456</text>

  <!-- Claude processes -->
  <rect x="270" y="212" width="100" height="35" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="320" y="234" text-anchor="middle" fill="var(--text)" font-size="10">Claude Code</text>

  <rect x="390" y="212" width="100" height="35" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="440" y="234" text-anchor="middle" fill="var(--text)" font-size="10">Claude Code</text>

  <line x1="340" y1="195" x2="320" y2="212" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#ov1)"/>
  <line x1="420" y1="195" x2="440" y2="212" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#ov1)"/>
  <text x="380" y="266" text-anchor="middle" fill="var(--text-dim)" font-size="8">each session sends requests up through the proxy</text>

  <!-- Arrows to APIs -->
  <line x1="510" y1="70" x2="588" y2="58" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ov1)"/>
  <line x1="510" y1="110" x2="588" y2="115" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ov1)"/>
  <text x="550" y="52" text-anchor="middle" fill="var(--text-dim)" font-size="8">forward as-is</text>
  <text x="550" y="107" text-anchor="middle" fill="var(--text-dim)" font-size="8">translated</text>

  <!-- LLM APIs -->
  <rect x="590" y="38" width="170" height="35" rx="6" fill="none" stroke="var(--purple)" stroke-width="2"/>
  <text x="675" y="60" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Anthropic API</text>

  <rect x="590" y="93" width="170" height="45" rx="6" fill="none" stroke="var(--text-dim)" stroke-width="1.5"/>
  <text x="675" y="113" text-anchor="middle" fill="var(--text-dim)" font-size="10">OpenAI · Gemini</text>
  <text x="675" y="128" text-anchor="middle" fill="var(--text-dim)" font-size="10">DeepSeek · Ollama · ...</text>

  <!-- AskUserQuestion -->
  <rect x="80" y="232" width="160" height="30" rx="6" fill="none" stroke="var(--yellow,#fa0)" stroke-width="1.5" stroke-dasharray="4"/>
  <text x="160" y="252" text-anchor="middle" fill="var(--text)" font-size="10">questions for you</text>
  <line x1="270" y1="240" x2="240" y2="245" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="3" marker-end="url(#ov1)"/>
  <line x1="80" y1="240" x2="75" y2="150" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="3" marker-end="url(#ov1)"/>
  <text x="46" y="200" fill="var(--text-dim)" font-size="8">shown</text>
  <text x="46" y="210" fill="var(--text-dim)" font-size="8">in UI</text>
</svg>
\`\`\`

## Why put a proxy in the middle?

- **See the real conversation.** The Inspector shows the exact system prompt, messages, tool definitions, and token counts on every call — the things Claude Code normally hides. Great for understanding *why* the model did what it did.
- **Change the conversation.** Rules are small bits of JavaScript that edit each request before it leaves your machine: pin a model version, strip wasteful context, block a tool, inject an instruction.
- **Change who answers.** Route Claude Code to OpenAI, Gemini, DeepSeek, a local Ollama model, or a different Claude version — per session, without Claude Code knowing.
- **Use it from anywhere.** The dashboard is a normal web app. Tunnel it and you can drive Claude Code from your phone.

## The other tabs

| Tab | What it's for |
|-----|---------------|
| **Inspector & CLI** | Watch live traffic and run Claude sessions in the browser |
| **Rules** | Rewrite requests on the fly — model overrides and more |
| **MCP Tools** | Give Claude new custom tools you write yourself |
| **Connect** | Point any external Claude Code at the proxy |

## Quick start

\`\`\`bash
npx vistaclair            # install + run
# or:
git clone https://github.com/hpfrei/vistaclair.git && cd vistaclair
npm install && npm start  # then open localhost:3457
\`\`\`

Now send Claude through the proxy — run this in any terminal:

\`\`\`bash
ANTHROPIC_BASE_URL=http://localhost:3456 claude
\`\`\`

That one environment variable is the whole trick: it tells Claude Code to send its API calls to vistaclair instead of straight to Anthropic. Everything appears in the Inspector. Works with interactive sessions, \`claude -p\`, and IDE integrations.

Want it on your phone? Tunnel the dashboard port:

\`\`\`bash
cloudflared tunnel --url http://localhost:3457
\`\`\`

---

> **vistaclair Pro** turns the same engine into a platform for building self-hosted, single-user web services — your own private apps, running on your own machine. It's a separate paid add-on; the core proxy and dashboard described here are free and need nothing extra.
`;

  const inspectorMd = `
# Inspector & CLI

## Inspector — see what Claude actually says

Every time Claude Code needs the model, it sends an HTTP request and gets a streamed reply. The Inspector records each one and lays them out as a timeline. Click any row to open the full payload — the same bytes that went over the wire.

\`\`\`svg
<svg viewBox="0 0 720 200" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <!-- Timeline line -->
  <line x1="40" y1="15" x2="40" y2="185" stroke="var(--text-dim)" stroke-width="1.5" opacity="0.4"/>

  <!-- Event 1: API call -->
  <circle cx="40" cy="28" r="6" fill="var(--green)" opacity="0.9"/>
  <rect x="60" y="14" width="640" height="28" rx="5" fill="none" stroke="var(--green)" stroke-width="1"/>
  <text x="72" y="33" fill="var(--text)" font-size="11" font-weight="500">POST /v1/messages</text>
  <text x="280" y="33" fill="var(--text-dim)" font-size="10">claude-opus-4-7</text>
  <text x="460" y="33" fill="var(--text-dim)" font-size="10">42.8k in · 1.2k out · $0.22</text>
  <text x="660" y="33" fill="var(--text-dim)" font-size="10">3.1s</text>

  <!-- Event 2: Tool use -->
  <circle cx="40" cy="64" r="6" fill="var(--purple)" opacity="0.9"/>
  <rect x="60" y="50" width="640" height="28" rx="5" fill="none" stroke="var(--purple)" stroke-width="1"/>
  <text x="72" y="69" fill="var(--text)" font-size="11" font-weight="500">tool_use: Edit</text>
  <text x="280" y="69" fill="var(--text-dim)" font-size="10">src/auth.js — 3 lines changed</text>
  <text x="660" y="69" fill="var(--green)" font-size="10">✓</text>

  <!-- Event 3: Another API call -->
  <circle cx="40" cy="100" r="6" fill="var(--green)" opacity="0.9"/>
  <rect x="60" y="86" width="640" height="28" rx="5" fill="none" stroke="var(--green)" stroke-width="1"/>
  <text x="72" y="105" fill="var(--text)" font-size="11" font-weight="500">POST /v1/messages</text>
  <text x="280" y="105" fill="var(--text-dim)" font-size="10">claude-opus-4-7</text>
  <text x="460" y="105" fill="var(--text-dim)" font-size="10">44.1k in · 890 out · $0.19</text>
  <text x="660" y="105" fill="var(--text-dim)" font-size="10">1.8s</text>

  <!-- Event 4: Hook -->
  <circle cx="40" cy="136" r="6" fill="var(--cyan,#0dd)" opacity="0.9"/>
  <rect x="60" y="122" width="640" height="28" rx="5" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1"/>
  <text x="72" y="141" fill="var(--text)" font-size="11" font-weight="500">hook: PreToolUse</text>
  <text x="280" y="141" fill="var(--text-dim)" font-size="10">Bash — matched "npm test"</text>
  <text x="660" y="141" fill="var(--cyan,#0dd)" font-size="10">0.4s</text>

  <!-- Event 5: AskUserQuestion -->
  <circle cx="40" cy="172" r="6" fill="var(--yellow,#fa0)" opacity="0.9"/>
  <rect x="60" y="158" width="640" height="28" rx="5" fill="none" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="4"/>
  <text x="72" y="177" fill="var(--text)" font-size="11" font-weight="500">AskUserQuestion</text>
  <text x="280" y="177" fill="var(--text-dim)" font-size="10">"Which database driver?"</text>
  <text x="660" y="177" fill="var(--yellow,#fa0)" font-size="10">waiting…</text>
</svg>
\`\`\`

Each row tells you the model used, the token split (in / out / cached), the dollar cost, and how long it took. Tool calls, hook firings, and questions to you are interleaved in order, so you can read a whole turn top to bottom.

### Tuning prompts: spotting the bad decisions

This is where the Inspector earns its keep. When Claude makes a *wrong* call — edits the wrong file, picks the wrong approach, burns tokens on a detour — open that turn and look at the exact input it was given. Usually the mistake is explained by what it saw:

- The **system prompt** was missing a constraint, or buried it under 40k tokens of noise.
- A **tool definition** was ambiguous, so it called the wrong one.
- An earlier **message** contained stale or misleading context.
- The **token breakdown** shows the cache wasn't hit, so cost spiked for no reason.

Once you can see the cause, you can fix it — tighten a prompt, add a Rule to strip the noise, or adjust a tool description. The Inspector turns "the model is dumb" into "the model was given bad input on line 12," which is something you can actually act on.

### The detail panel

\`\`\`svg
<svg viewBox="0 0 720 260" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <defs>
    <marker id="ip1" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker>
  </defs>

  <!-- Left column: the request -->
  <rect x="10" y="10" width="220" height="240" rx="8" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="120" y="34" text-anchor="middle" fill="var(--accent)" font-size="12" font-weight="700">What Claude sent</text>
  <text x="120" y="55" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">System prompt</text>
  <text x="120" y="71" text-anchor="middle" fill="var(--text-dim)" font-size="9">full text · char-count gauge</text>
  <line x1="30" y1="82" x2="210" y2="82" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="120" y="100" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">Messages</text>
  <text x="120" y="116" text-anchor="middle" fill="var(--text-dim)" font-size="9">every role + content + tokens</text>
  <line x1="30" y1="127" x2="210" y2="127" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="120" y="145" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">Tool definitions</text>
  <text x="120" y="161" text-anchor="middle" fill="var(--text-dim)" font-size="9">all tools offered this turn</text>
  <line x1="30" y1="172" x2="210" y2="172" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="120" y="190" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">Request headers</text>
  <line x1="30" y1="201" x2="210" y2="201" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="120" y="219" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">cURL export</text>
  <text x="120" y="235" text-anchor="middle" fill="var(--text-dim)" font-size="9">replay it yourself (key masked)</text>

  <!-- Middle column: the reply -->
  <rect x="250" y="10" width="220" height="240" rx="8" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="360" y="34" text-anchor="middle" fill="var(--green)" font-size="12" font-weight="700">What came back</text>
  <text x="360" y="55" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">Response preview</text>
  <text x="360" y="71" text-anchor="middle" fill="var(--text-dim)" font-size="9">live-rendered markdown</text>
  <line x1="270" y1="82" x2="450" y2="82" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="360" y="100" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">Thinking blocks</text>
  <text x="360" y="116" text-anchor="middle" fill="var(--text-dim)" font-size="9">the model's reasoning, if present</text>
  <line x1="270" y1="127" x2="450" y2="127" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="360" y="145" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">Tool calls</text>
  <text x="360" y="161" text-anchor="middle" fill="var(--text-dim)" font-size="9">inputs, outputs, errors as JSON</text>
  <line x1="270" y1="172" x2="450" y2="172" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="360" y="190" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">SSE event stream</text>
  <text x="360" y="206" text-anchor="middle" fill="var(--text-dim)" font-size="9">raw events as they arrived</text>
  <line x1="270" y1="217" x2="450" y2="217" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="360" y="235" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">Hook calls</text>

  <!-- Right column: the numbers -->
  <rect x="490" y="10" width="220" height="135" rx="8" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="600" y="34" text-anchor="middle" fill="var(--purple)" font-size="12" font-weight="700">The numbers</text>
  <text x="600" y="56" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">Token breakdown</text>
  <text x="600" y="73" text-anchor="middle" fill="var(--text-dim)" font-size="9">input · output · cache read</text>
  <text x="600" y="87" text-anchor="middle" fill="var(--text-dim)" font-size="9">cache create · reasoning</text>
  <line x1="510" y1="99" x2="690" y2="99" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="600" y="118" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">Cost tracking</text>
  <text x="600" y="134" text-anchor="middle" fill="var(--text-dim)" font-size="9">per-turn · per-group · session</text>

  <rect x="490" y="160" width="220" height="90" rx="8" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="600" y="184" text-anchor="middle" fill="var(--cyan,#0dd)" font-size="12" font-weight="700">Subagents</text>
  <text x="600" y="204" text-anchor="middle" fill="var(--text-dim)" font-size="9">color-coded badge per agent</text>
  <text x="600" y="220" text-anchor="middle" fill="var(--text-dim)" font-size="9">swimlane view for parallel work</text>
  <text x="600" y="236" text-anchor="middle" fill="var(--text-dim)" font-size="9">who spawned whom, side by side</text>
</svg>
\`\`\`

The **cURL export** is handy for tuning: copy any request as a ready-to-run \`curl\` command (your key masked), tweak one line, and replay it against the API to see how the answer changes.

### One tab per session — nothing mixes

\`\`\`svg
<svg viewBox="0 0 700 100" xmlns="http://www.w3.org/2000/svg" style="max-width:700px;font-family:system-ui,sans-serif">
  <!-- Tab bar -->
  <rect x="10" y="10" width="680" height="35" rx="6" fill="none" stroke="var(--text-dim)" stroke-width="1"/>

  <rect x="15" y="14" width="120" height="27" rx="4" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <circle cx="30" cy="28" r="4" fill="var(--green)"/>
  <text x="42" y="32" fill="var(--text)" font-size="10" font-weight="500">cli-tab-1</text>
  <text x="120" y="32" fill="var(--text-dim)" font-size="8">running</text>

  <rect x="145" y="14" width="120" height="27" rx="4" fill="none" stroke="var(--accent)" stroke-width="1"/>
  <circle cx="160" cy="28" r="4" fill="var(--text-dim)"/>
  <text x="172" y="32" fill="var(--text)" font-size="10">cli-tab-2</text>
  <text x="256" y="32" fill="var(--text-dim)" font-size="8">idle</text>

  <rect x="275" y="14" width="120" height="27" rx="4" fill="none" stroke="var(--accent)" stroke-width="1"/>
  <circle cx="290" cy="28" r="4" fill="var(--cyan,#0dd)"/>
  <text x="302" y="32" fill="var(--text)" font-size="10">chat-tab-3</text>
  <text x="396" y="32" fill="var(--text-dim)" font-size="8">running</text>

  <rect x="405" y="14" width="120" height="27" rx="4" fill="none" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="3"/>
  <circle cx="420" cy="28" r="4" fill="var(--yellow,#fa0)"/>
  <text x="432" y="32" fill="var(--text)" font-size="10">ext-1</text>
  <text x="508" y="32" fill="var(--text-dim)" font-size="8">external</text>

  <!-- Explanation -->
  <text x="15" y="65" fill="var(--text-dim)" font-size="10">Every Claude Code process gets its own tab and its own recording, so concurrent sessions never bleed together.</text>
  <text x="15" y="82" fill="var(--text-dim)" font-size="10">ext-N tabs appear automatically when an outside Claude CLI connects through the proxy.</text>
</svg>
\`\`\`

Each session's traffic is saved to \`interactions/{sessionId}/\` as JSON, so you can reopen and study any past run — and resume it into a fresh CLI tab.

---

## CLI — run Claude inside the dashboard

You don't have to use an external terminal. The CLI tab gives you Claude Code right in the browser: multiple tabs, each an independent session with its own working directory and its own model routing. Paste an image from your clipboard or drag any file straight onto a session and it's uploaded for Claude to use.

\`\`\`svg
<svg viewBox="0 0 720 200" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <defs>
    <marker id="cl1" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker>
  </defs>

  <!-- Tab 1 -->
  <rect x="10" y="10" width="220" height="175" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="120" y="35" text-anchor="middle" fill="var(--green)" font-size="12" font-weight="600">Tab 1: my-project</text>
  <text x="120" y="55" text-anchor="middle" fill="var(--text-dim)" font-size="9">cwd: ~/projects/my-project</text>
  <text x="120" y="75" text-anchor="middle" fill="var(--text-dim)" font-size="9">model: claude-opus-4-7</text>
  <rect x="25" y="88" width="190" height="45" rx="4" fill="none" stroke="var(--text-dim)" stroke-width="0.8"/>
  <text x="30" y="105" fill="var(--text-dim)" font-size="9" font-family="monospace">$ refactor the auth module</text>
  <text x="30" y="120" fill="var(--green)" font-size="9" font-family="monospace">Working on src/auth.js...</text>
  <text x="120" y="155" text-anchor="middle" fill="var(--text-dim)" font-size="9">⚙ model routing · ▶ resume</text>
  <text x="120" y="172" text-anchor="middle" fill="var(--text-dim)" font-size="9">✕ stop</text>

  <!-- Tab 2 -->
  <rect x="250" y="10" width="220" height="175" rx="8" fill="none" stroke="var(--cyan,#0dd)" stroke-width="2"/>
  <text x="360" y="35" text-anchor="middle" fill="var(--cyan,#0dd)" font-size="12" font-weight="600">Tab 2: tests</text>
  <text x="360" y="55" text-anchor="middle" fill="var(--text-dim)" font-size="9">cwd: ~/projects/my-project</text>
  <text x="360" y="75" text-anchor="middle" fill="var(--text-dim)" font-size="9">model: gemini-3.1-pro</text>
  <rect x="265" y="88" width="190" height="45" rx="4" fill="none" stroke="var(--text-dim)" stroke-width="0.8"/>
  <text x="270" y="105" fill="var(--text-dim)" font-size="9" font-family="monospace">$ write tests for auth.js</text>
  <text x="270" y="120" fill="var(--cyan,#0dd)" font-size="9" font-family="monospace">Creating test/auth.test.js</text>
  <text x="360" y="155" text-anchor="middle" fill="var(--text-dim)" font-size="9">⚙ routed to Gemini</text>
  <text x="360" y="172" text-anchor="middle" fill="var(--text-dim)" font-size="9">independent session</text>

  <!-- Tab 3 -->
  <rect x="490" y="10" width="220" height="175" rx="8" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="600" y="35" text-anchor="middle" fill="var(--accent)" font-size="12" font-weight="600">&gt; api-server</text>
  <text x="600" y="55" text-anchor="middle" fill="var(--text-dim)" font-size="9">spawned from Directories tab</text>
  <text x="600" y="75" text-anchor="middle" fill="var(--text-dim)" font-size="9">model: deepseek-r1</text>
  <rect x="505" y="88" width="190" height="45" rx="4" fill="none" stroke="var(--text-dim)" stroke-width="0.8"/>
  <text x="510" y="105" fill="var(--text-dim)" font-size="9" font-family="monospace">$ debug the 500 on /api</text>
  <text x="510" y="120" fill="var(--accent)" font-size="9" font-family="monospace">Reading server.js...</text>
  <text x="600" y="155" text-anchor="middle" fill="var(--text-dim)" font-size="9">launched in a chosen folder</text>
  <text x="600" y="172" text-anchor="middle" fill="var(--text-dim)" font-size="9">model routed via proxy</text>

  <text x="360" y="198" text-anchor="middle" fill="var(--text-dim)" font-size="9">All tabs run at once. Each has its own model routing — changing one never touches another.</text>
</svg>
\`\`\`

### Per-session model routing

Each tab carries a **model map**: when Claude asks for a tier (fable, opus, sonnet, or haiku), the proxy looks it up here and substitutes the model you chose. Leave an entry blank to forward that tier to Anthropic unchanged.

\`\`\`svg
<svg viewBox="0 0 600 130" xmlns="http://www.w3.org/2000/svg" style="max-width:600px;font-family:system-ui,sans-serif">
  <defs>
    <marker id="cl2" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker>
  </defs>

  <!-- Claude request -->
  <rect x="10" y="30" width="120" height="50" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="70" y="52" text-anchor="middle" fill="var(--text)" font-size="10" font-weight="500">Claude Code</text>
  <text x="70" y="68" text-anchor="middle" fill="var(--text-dim)" font-size="8">asks for "opus"</text>

  <line x1="130" y1="55" x2="188" y2="55" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#cl2)"/>

  <!-- Model map -->
  <rect x="190" y="10" width="190" height="95" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="285" y="32" text-anchor="middle" fill="var(--green)" font-size="11" font-weight="600">model map</text>
  <text x="285" y="52" text-anchor="middle" fill="var(--text-dim)" font-size="9">opus → gemini-3.1-pro</text>
  <text x="285" y="68" text-anchor="middle" fill="var(--text-dim)" font-size="9">sonnet → gpt-5.4</text>
  <text x="285" y="84" text-anchor="middle" fill="var(--text-dim)" font-size="9">haiku → deepseek-v3.2</text>

  <line x1="380" y1="35" x2="438" y2="30" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#cl2)"/>
  <line x1="380" y1="55" x2="438" y2="55" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#cl2)"/>
  <line x1="380" y1="75" x2="438" y2="80" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#cl2)"/>

  <!-- Providers -->
  <rect x="440" y="12" width="140" height="28" rx="5" fill="none" stroke="var(--text-dim)" stroke-width="1"/>
  <text x="510" y="30" text-anchor="middle" fill="var(--text-dim)" font-size="9">Google Gemini</text>

  <rect x="440" y="44" width="140" height="28" rx="5" fill="none" stroke="var(--text-dim)" stroke-width="1"/>
  <text x="510" y="62" text-anchor="middle" fill="var(--text-dim)" font-size="9">OpenAI</text>

  <rect x="440" y="76" width="140" height="28" rx="5" fill="none" stroke="var(--text-dim)" stroke-width="1"/>
  <text x="510" y="94" text-anchor="middle" fill="var(--text-dim)" font-size="9">DeepSeek</text>

  <text x="300" y="125" text-anchor="middle" fill="var(--text-dim)" font-size="9">Blank entry → forwarded to Anthropic as-is. Every tab maps independently.</text>
</svg>
\`\`\`

vistaclair translates the request into each provider's own format and the reply back into Anthropic's, so Claude Code never notices it's talking to someone else.
`;

  const rulesMd = `
# Rules — rewrite the traffic

Rules are the most powerful part of vistaclair. Each one is a small JavaScript function that runs on **every request** just before it leaves your machine. The function gets the full request body and can change anything: the model, the system prompt, the messages, the tool list. This is how you bend Claude Code to your will without forking it.

\`\`\`svg
<svg viewBox="0 0 720 100" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <defs><marker id="ru1" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker></defs>

  <rect x="10" y="20" width="100" height="40" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="60" y="38" text-anchor="middle" fill="var(--text)" font-size="10">request</text>
  <text x="60" y="52" text-anchor="middle" fill="var(--text-dim)" font-size="8">from Claude</text>

  <line x1="110" y1="40" x2="138" y2="40" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#ru1)"/>

  <rect x="140" y="15" width="120" height="50" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="200" y="36" text-anchor="middle" fill="var(--text)" font-size="9" font-weight="500">Rule 1</text>
  <text x="200" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">swap model</text>

  <line x1="260" y1="40" x2="288" y2="40" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#ru1)"/>

  <rect x="290" y="15" width="120" height="50" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="350" y="36" text-anchor="middle" fill="var(--text)" font-size="9" font-weight="500">Rule 2</text>
  <text x="350" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">strip git status</text>

  <line x1="410" y1="40" x2="438" y2="40" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#ru1)"/>

  <rect x="440" y="15" width="120" height="50" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="500" y="36" text-anchor="middle" fill="var(--text)" font-size="9" font-weight="500">Rule 3</text>
  <text x="500" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">inject instruction</text>

  <line x1="560" y1="40" x2="588" y2="40" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#ru1)"/>

  <rect x="590" y="20" width="110" height="40" rx="6" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="645" y="38" text-anchor="middle" fill="var(--green)" font-size="10" font-weight="500">provider</text>
  <text x="645" y="52" text-anchor="middle" fill="var(--text-dim)" font-size="8">gets final request</text>

  <text x="360" y="88" text-anchor="middle" fill="var(--text-dim)" font-size="9">Rules run top to bottom. Toggle any one on/off, or drag to reorder, in this tab.</text>
</svg>
\`\`\`

## Built-in rules

vistaclair ships with six rules you can flip on without writing any code. They cover the things people reach for most. Four are on out of the box; the two that change auth or cost behaviour are left off until you opt in.

| Rule | What it does | Default |
|------|--------------|---------|
| **Model Override** | Pin or swap the model for every request — map a tier (fable/opus/sonnet/haiku) or an exact id to another version or another provider. Edit the map inside. | **on** |
| **AskUserQuestion → MCP** | Reroute Claude's native question tool to vistaclair's own, so prompts pop up in this dashboard instead of the terminal. | **on** |
| **Tool Filter** | Remove specific tools from the request by name, so the model simply can't call them. Edit the block-list inside. | **on** |
| **Strip Git Status** | Delete the large git-status block Claude Code injects into the system prompt — saves tokens on every turn. | **on** |
| **Auth Inject** | Attach your Anthropic OAuth token (from a Max/Pro subscription) so requests authenticate without an API key. | off |
| **Title Schema Shortcut** | Answer Claude Code's tiny "generate a title" requests with a canned response instead of paying for a round-trip. | off |

Click any built-in to read or edit its source — they're ordinary rule files, fully editable.

## The most common rule: override the model

Open **Model Override** and edit it. A rule just reads and writes \`ctx.body\` — the parsed request — directly. Send every opus request to a different version, or route a tier to another provider by setting the model id:

\`\`\`javascript
module.exports = function(ctx) {
  // ctx.body is the full request body — mutate it in place.
  if (ctx.body.model.startsWith('claude-opus')) {
    ctx.body.model = 'claude-sonnet-4-6';   // downgrade opus to save cost
  }
  // Route only this dashboard's CLI tabs somewhere else:
  if (ctx.instanceId?.startsWith('cli-') && ctx.body.model.includes('haiku')) {
    ctx.body.model = 'gpt-5.4-mini';        // a model id from your Models list
  }
};
\`\`\`

The Inspector still shows the model Claude *asked* for next to the one that actually ran, so an override is never invisible.

## Writing your own rule

Every rule is \`module.exports = function(ctx) { ... }\`. The \`ctx\` object is your whole toolkit:

| \`ctx\` field | What it gives you |
|------------|-------------------|
| \`ctx.body\` | The full request body — mutate it in place (model, system, messages, tools) |
| \`ctx.isStreaming\` | True when the request is streaming (SSE) |
| \`ctx.instanceId\` | Which session sent this request (e.g. \`cli-3\`, \`ext-1\`) |
| \`ctx.isInternalInstance\` | True for sessions started inside the dashboard, false for external ones |
| \`ctx.helpers\` | Helper functions — including \`sendDummyResponse()\` to answer without calling the model |

What you **return** decides what happens next:

- **return nothing** → the (possibly edited) request goes on to the provider.
- **\`return true\`** (after \`ctx.helpers.sendDummyResponse(ctx, { text })\`) → skip the provider entirely and reply with your own canned response. This is exactly how the Title Shortcut built-in avoids paying for trivial requests.
- **\`return { transformSSE, transformBody }\`** → let the request through, but also rewrite the *response*. \`transformSSE(line)\` runs on each streamed SSE line; \`transformBody(json)\` runs on a non-streaming reply. Return the modified value from each.

\`\`\`javascript
// Block a tool and add a house rule to every system prompt.
module.exports = function(ctx) {
  if (Array.isArray(ctx.body.tools)) {
    ctx.body.tools = ctx.body.tools.filter(t => t.name !== 'Bash');
  }
  if (typeof ctx.body.system === 'string') {
    ctx.body.system += '\\n\\nNever edit files under /infra without asking first.';
  }
};
\`\`\`

So a rule can change what Claude *sends* (via \`ctx.body\`) and what Claude *sees* come back (via the returned transforms) — both halves of the conversation are yours.

## Don't want to write JavaScript? Describe it.

\`\`\`svg
<svg viewBox="0 0 700 100" xmlns="http://www.w3.org/2000/svg" style="max-width:700px;font-family:system-ui,sans-serif">
  <defs>
    <marker id="ru2" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker>
  </defs>

  <rect x="10" y="12" width="220" height="60" rx="8" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="120" y="35" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">"Block rm, sudo, and any</text>
  <text x="120" y="50" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500"> destructive shell command"</text>
  <text x="120" y="66" text-anchor="middle" fill="var(--text-dim)" font-size="9">describe it in plain English</text>

  <line x1="230" y1="42" x2="298" y2="42" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ru2)"/>
  <text x="264" y="34" text-anchor="middle" fill="var(--text-dim)" font-size="8">generates</text>

  <rect x="300" y="8" width="180" height="68" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="390" y="32" text-anchor="middle" fill="var(--green)" font-size="12" font-weight="600">a rule .js</text>
  <text x="390" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="9">JavaScript, saved for you</text>
  <text x="390" y="64" text-anchor="middle" fill="var(--text-dim)" font-size="9">hot-loaded · toggleable</text>

  <line x1="480" y1="42" x2="518" y2="42" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ru2)"/>

  <rect x="520" y="12" width="170" height="60" rx="8" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="605" y="35" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">review &amp; edit</text>
  <text x="605" y="52" text-anchor="middle" fill="var(--text-dim)" font-size="9">read the JS it wrote</text>
  <text x="605" y="66" text-anchor="middle" fill="var(--text-dim)" font-size="9">tweak or regenerate</text>

  <text x="350" y="95" text-anchor="middle" fill="var(--text-dim)" font-size="9">Describe → generate → toggle on. The source is yours to read and edit afterward.</text>
</svg>
\`\`\`

Type what you want in plain English and vistaclair writes the rule for you, saving it to \`capabilities/proxy-rules/\`. Then review the source, edit it, toggle it on, and drag it into position. Changes are hot-loaded — no restart.
`;

  const mcpMd = `
# MCP Tools — give Claude new abilities

MCP (Model Context Protocol) is the standard way to hand a model extra tools. vistaclair runs its own MCP server and registers it with every session automatically — so any tool you define here is instantly available to Claude, no restart and no config to wire up. Every call shows up in the Inspector next to the API traffic.

\`\`\`svg
<svg viewBox="0 0 720 210" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <defs><marker id="mc1" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker></defs>

  <!-- Claude process -->
  <rect x="10" y="55" width="120" height="55" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="70" y="78" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Claude Code</text>
  <text x="70" y="96" text-anchor="middle" fill="var(--text-dim)" font-size="9">any session</text>

  <!-- MCP Server -->
  <rect x="210" y="15" width="200" height="140" rx="8" fill="none" stroke="var(--purple)" stroke-width="2"/>
  <text x="310" y="40" text-anchor="middle" fill="var(--purple)" font-size="13" font-weight="600">MCP Server</text>
  <text x="310" y="60" text-anchor="middle" fill="var(--text-dim)" font-size="9">auto-registered every session</text>
  <text x="310" y="78" text-anchor="middle" fill="var(--text-dim)" font-size="9">stdio transport · JSON-RPC</text>
  <text x="310" y="96" text-anchor="middle" fill="var(--text-dim)" font-size="9">inputs validated by schema</text>
  <text x="310" y="114" text-anchor="middle" fill="var(--text-dim)" font-size="9">external clients can connect too</text>
  <text x="310" y="132" text-anchor="middle" fill="var(--text-dim)" font-size="9">every call logged in Inspector</text>

  <!-- Custom handlers -->
  <rect x="490" y="15" width="190" height="55" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="585" y="38" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Your custom tools</text>
  <text x="585" y="55" text-anchor="middle" fill="var(--text-dim)" font-size="9">JavaScript handlers you write</text>

  <!-- Built-in tools -->
  <rect x="490" y="85" width="190" height="70" rx="6" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="585" y="106" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Built-in tools</text>
  <text x="585" y="124" text-anchor="middle" fill="var(--text-dim)" font-size="9">vista-AskUserQuestion</text>
  <text x="585" y="140" text-anchor="middle" fill="var(--text-dim)" font-size="9">chat (sub-session)</text>

  <!-- Arrows -->
  <line x1="130" y1="82" x2="210" y2="82" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#mc1)"/>
  <text x="170" y="74" text-anchor="middle" fill="var(--text-dim)" font-size="8">tool_use</text>
  <line x1="410" y1="42" x2="490" y2="42" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#mc1)"/>
  <line x1="410" y1="110" x2="490" y2="118" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#mc1)"/>

  <!-- Dashboard logging -->
  <rect x="210" y="170" width="200" height="30" rx="6" fill="none" stroke="var(--green)" stroke-width="1" stroke-dasharray="3"/>
  <text x="310" y="190" text-anchor="middle" fill="var(--text-dim)" font-size="9">→ calls appear in the Inspector timeline</text>
</svg>
\`\`\`

## How a tool comes to life

\`\`\`svg
<svg viewBox="0 0 700 80" xmlns="http://www.w3.org/2000/svg" style="max-width:700px;font-family:system-ui,sans-serif">
  <defs><marker id="mc2" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker></defs>

  <rect x="10" y="15" width="130" height="45" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="75" y="35" text-anchor="middle" fill="var(--text)" font-size="10" font-weight="500">1 · Define</text>
  <text x="75" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">name, params, description</text>

  <line x1="140" y1="38" x2="168" y2="38" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#mc2)"/>

  <rect x="170" y="15" width="130" height="45" rx="6" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="235" y="35" text-anchor="middle" fill="var(--text)" font-size="10" font-weight="500">2 · Write handler</text>
  <text x="235" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">an async JS function</text>

  <line x1="300" y1="38" x2="328" y2="38" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#mc2)"/>

  <rect x="330" y="15" width="130" height="45" rx="6" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="395" y="35" text-anchor="middle" fill="var(--text)" font-size="10" font-weight="500">3 · Auto-reload</text>
  <text x="395" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">server picks it up</text>

  <line x1="460" y1="38" x2="488" y2="38" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#mc2)"/>

  <rect x="490" y="15" width="130" height="45" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="555" y="35" text-anchor="middle" fill="var(--text)" font-size="10" font-weight="500">4 · Claude uses it</text>
  <text x="555" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">validated + logged</text>

  <text x="350" y="75" text-anchor="middle" fill="var(--text-dim)" font-size="9">Inputs are checked against the tool's schema before your handler runs. Results land in the Inspector.</text>
</svg>
\`\`\`

A handler is just JavaScript that returns content for the model:

\`\`\`javascript
const response = await fetch(url);
const text = await response.text();
return {
  content: [{ type: "text", text }]
};
\`\`\`

Handlers can reach Node.js built-ins (via \`import()\`), the dashboard's WebSocket, and your environment variables — so a tool can hit an API, read a file, or push something to the UI.

## Built-in tools

| Tool | Purpose |
|------|---------|
| **vista-AskUserQuestion** | Routes Claude's questions to this dashboard so you answer them in the browser, not the terminal. On by default. |
| **chat** | Lets Claude spin up a sub-session through the REST API — multi-turn via \`session_id\`, with its own \`cwd\`. Off by default. |
`;

  const connectMd = `
# Connect an external Claude

Everything so far works with Claude sessions you start from the dashboard. But you can also point a Claude Code running *anywhere* — your normal terminal, a CI job, an IDE — at vistaclair, and its traffic shows up in the Inspector. There are three ways in.

## Method 1 — the transparent proxy (the easy one)

Set one environment variable and run Claude as usual:

\`\`\`bash
ANTHROPIC_BASE_URL=http://localhost:3456 claude
\`\`\`

Or non-interactively:

\`\`\`bash
ANTHROPIC_BASE_URL=http://localhost:3456 claude -p "your prompt"
\`\`\`

\`\`\`svg
<svg viewBox="0 0 720 120" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <defs><marker id="cn1" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker></defs>

  <rect x="10" y="25" width="150" height="60" rx="8" fill="none" stroke="var(--cyan,#0dd)" stroke-width="2"/>
  <text x="85" y="50" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">external claude</text>
  <text x="85" y="68" text-anchor="middle" fill="var(--text-dim)" font-size="9">ANTHROPIC_BASE_URL</text>
  <text x="85" y="80" text-anchor="middle" fill="var(--text-dim)" font-size="9">= localhost:3456</text>

  <line x1="160" y1="55" x2="228" y2="55" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#cn1)"/>
  <text x="194" y="47" text-anchor="middle" fill="var(--text-dim)" font-size="8">API calls</text>

  <rect x="230" y="15" width="200" height="80" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="330" y="40" text-anchor="middle" fill="var(--green)" font-size="12" font-weight="600">vistaclair proxy</text>
  <text x="330" y="58" text-anchor="middle" fill="var(--text-dim)" font-size="9">records for the Inspector</text>
  <text x="330" y="72" text-anchor="middle" fill="var(--text-dim)" font-size="9">applies rules &amp; routing</text>
  <text x="330" y="86" text-anchor="middle" fill="var(--text-dim)" font-size="9">opens an ext-N tab</text>

  <line x1="430" y1="55" x2="498" y2="55" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#cn1)"/>
  <text x="464" y="47" text-anchor="middle" fill="var(--text-dim)" font-size="8">forward</text>

  <rect x="500" y="30" width="150" height="45" rx="6" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="575" y="57" text-anchor="middle" fill="var(--text)" font-size="11">the model API</text>

  <text x="360" y="115" text-anchor="middle" fill="var(--text-dim)" font-size="9">Claude Code can't tell the difference. Its traffic appears in a new ext-N tab.</text>
</svg>
\`\`\`

Works with interactive, programmatic (\`claude -p\`), and IDE sessions. On a remote machine? Tunnel the proxy port and point at the tunnel instead:

\`\`\`bash
cloudflared tunnel --url http://localhost:3456 --name proxy-tunnel
# then: ANTHROPIC_BASE_URL=https://proxy-tunnel.your-domain.com claude -p "prompt"
\`\`\`

---

## Method 2 — the MCP bridge

Use this when you want an external Claude to reach vistaclair's **MCP tools** (not just be recorded). A tiny bridge connects Claude's stdio to the dashboard over WebSocket.

\`\`\`svg
<svg viewBox="0 0 720 130" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <defs><marker id="cn2" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker></defs>

  <rect x="10" y="20" width="140" height="75" rx="8" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="80" y="45" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">external claude</text>
  <text x="80" y="63" text-anchor="middle" fill="var(--text-dim)" font-size="9">--mcp-config</text>
  <text x="80" y="78" text-anchor="middle" fill="var(--text-dim)" font-size="9">points to the bridge</text>

  <line x1="150" y1="58" x2="208" y2="58" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#cn2)"/>
  <text x="180" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">stdio</text>

  <rect x="210" y="25" width="150" height="65" rx="8" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="285" y="48" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">MCP bridge</text>
  <text x="285" y="66" text-anchor="middle" fill="var(--text-dim)" font-size="9">lib/mcp-bridge.js</text>
  <text x="285" y="80" text-anchor="middle" fill="var(--text-dim)" font-size="9">stdio ↔ WebSocket</text>

  <line x1="360" y1="58" x2="418" y2="58" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#cn2)"/>
  <text x="390" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">WebSocket</text>

  <rect x="420" y="20" width="160" height="75" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="500" y="44" text-anchor="middle" fill="var(--green)" font-size="12" font-weight="600">dashboard</text>
  <text x="500" y="62" text-anchor="middle" fill="var(--text-dim)" font-size="9">MCP server</text>
  <text x="500" y="78" text-anchor="middle" fill="var(--text-dim)" font-size="9">custom + built-in tools</text>

  <rect x="600" y="30" width="100" height="50" rx="6" fill="none" stroke="var(--purple)" stroke-width="1"/>
  <text x="650" y="52" text-anchor="middle" fill="var(--text)" font-size="10">Inspector</text>
  <text x="650" y="68" text-anchor="middle" fill="var(--text-dim)" font-size="8">logs every call</text>
  <line x1="580" y1="58" x2="600" y2="55" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#cn2)"/>

  <text x="360" y="120" text-anchor="middle" fill="var(--text-dim)" font-size="9">The external Claude gains all your MCP tools, and every call is recorded.</text>
</svg>
\`\`\`

Add this to \`.mcp.json\` (project) or \`~/.claude.json\` (global):

\`\`\`json
{
  "mcpServers": {
    "vistaclair": {
      "command": "node",
      "args": ["/path/to/vistaclair/lib/mcp-bridge.js", "integrated"],
      "env": {
        "VISTACLAIR_AUTH_TOKEN": "<your-token>",
        "VISTACLAIR_DASHBOARD_PORT": "3457"
      }
    }
  }
}
\`\`\`

---

## Method 3 — the REST API

Drive Claude from a script, a cron job, or your own app. \`POST /api/run\` starts a session and streams the result back.

\`\`\`svg
<svg viewBox="0 0 720 110" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <defs><marker id="cn3" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker></defs>

  <rect x="10" y="15" width="140" height="70" rx="8" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="80" y="40" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">your script</text>
  <text x="80" y="58" text-anchor="middle" fill="var(--text-dim)" font-size="9">curl · Node · Python</text>
  <text x="80" y="72" text-anchor="middle" fill="var(--text-dim)" font-size="9">any HTTP client</text>

  <line x1="150" y1="50" x2="208" y2="50" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#cn3)"/>
  <text x="180" y="42" text-anchor="middle" fill="var(--text-dim)" font-size="8">POST /api/run</text>

  <rect x="210" y="10" width="200" height="80" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="310" y="35" text-anchor="middle" fill="var(--green)" font-size="12" font-weight="600">dashboard :3457</text>
  <text x="310" y="55" text-anchor="middle" fill="var(--text-dim)" font-size="9">Bearer-token auth</text>
  <text x="310" y="70" text-anchor="middle" fill="var(--text-dim)" font-size="9">SSE stream or JSON</text>
  <text x="310" y="82" text-anchor="middle" fill="var(--text-dim)" font-size="9">multi-turn via sessionId</text>

  <line x1="410" y1="50" x2="468" y2="50" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#cn3)"/>

  <rect x="470" y="20" width="120" height="55" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="530" y="44" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Claude Code</text>
  <text x="530" y="60" text-anchor="middle" fill="var(--text-dim)" font-size="9">spawned by the API</text>

  <line x1="590" y1="48" x2="618" y2="48" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#cn3)"/>
  <rect x="620" y="25" width="80" height="40" rx="5" fill="none" stroke="var(--purple)" stroke-width="1"/>
  <text x="660" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="9">model API</text>

  <text x="360" y="107" text-anchor="middle" fill="var(--text-dim)" font-size="9">Supports file uploads, AskUserQuestion handling, a chosen working directory, and session resume.</text>
</svg>
\`\`\`

\`\`\`bash
curl -N -X POST http://localhost:3457/api/run \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"chat","prompt":"List all TODO comments"}'
\`\`\`

The stream sends \`text\` (a delta), \`ask\` (Claude needs input), \`error\`, and \`done\` (which includes a \`sessionId\` you can reuse for the next turn). Set \`"stream": false\` for a single JSON response.

---

## Auth & ports

| Port | Binds to | Purpose |
|------|----------|---------|
| **:3456** | localhost | Proxy — intercepts Claude's API calls |
| **:3457** | 0.0.0.0 | Dashboard — web UI, REST API, WebSocket |

Authenticate with an \`Authorization: Bearer <token>\` header or a \`token=<token>\` cookie. The token is printed when vistaclair starts, or you can set it yourself with the \`AUTH_TOKEN\` environment variable.
`;


  // --- Render sections ---
  function renderSections() {
    const sections = {
      'home-overview': overviewMd,
      'home-inspector': inspectorMd,
      'home-rules': rulesMd,
      'home-mcp': mcpMd,
      'home-connect': connectMd,
    };
    for (const [id, md] of Object.entries(sections)) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('markdown-body');
        renderMarkdown(md.trim(), el);
      }
    }
  }

  if (document.readyState === 'complete') {
    renderSections();
  } else {
    window.addEventListener('load', renderSections);
  }
})();
