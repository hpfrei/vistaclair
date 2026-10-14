#!/usr/bin/env node
// Orchestrator MCP Server — the tools of an orchestration run (src/orchestration.js).
// Spawned per-session via --mcp-config (CLI tabs) or options.mcpServers (Agent
// SDK sessions), only for sessions stamped with an orchestration role.
// VISTACLAIR_ORCH_ROLE picks the tool set:
//   orchestrator  launch_cli, list_workers, resume_worker, end_run
//   worker        report
// VISTACLAIR_ORCH_ENGINE=sdk adds SendMessage and ListAgents for both roles: an
// SDK session has Claude Code's own cross-session messaging disabled, and these
// keep its name, so the role cards read the same on both engines.
// Every call goes to the dashboard with the session's instanceId; the dashboard
// re-checks the caller's role, so the env var only decides what is listed.

import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import http from "http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkBase = path.join(__dirname, "..", "mcp-servers", "integrated", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");

const dashboardPort = process.env.VISTACLAIR_DASHBOARD_PORT || "3457";
const authToken = process.env.VISTACLAIR_AUTH_TOKEN || "";
const instanceId = process.env.VISTACLAIR_INSTANCE_ID || "";
const role = process.env.VISTACLAIR_ORCH_ROLE || "";
const engine = process.env.VISTACLAIR_ORCH_ENGINE || "cli";

const ORCHESTRATOR_TOOLS = [
  {
    name: "launch_cli",
    path: "launch",
    description: "Launch a NEW worker CLI session (a visible Claude Code tab) with a self-contained brief, auto-submitted. The worker is told your address and reports back to you. At most 3 workers run at once. Returns the worker's address, tab, working directory and branch.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title (becomes part of the worker's address and tab title)" },
        task: { type: "string", description: "The complete brief: goal, files/areas, acceptance criteria, constraints, what is ruled out" },
        cwd: { type: "string", description: "Working directory, inside the run root (default: the run root)" },
        isolation: { type: "string", enum: ["worktree", "none"], description: "worktree: own git worktree and branch; none: share the directory (default: the run's setting)" },
        model: { type: "string", enum: ["fable", "opus", "sonnet", "haiku"], description: "The worker's model, as for the Agent tool: fable or opus for hard design and coding, sonnet for routine work, haiku for mechanical tasks (default: the dashboard's default model)" },
      },
      required: ["title", "task"],
    },
  },
  {
    name: "list_workers",
    path: "workers",
    description: "List this run's workers: address, running / paused / stopped, branch, working directory, last report, TODO progress and the paths of its TODO.md and NOTES.md (read those to follow a worker; do not message it to ask); plus the number of undelivered events.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "resume_worker",
    path: "resume-worker",
    description: "Bring a paused or stopped worker back. mode \"continue\" resumes its own session (it keeps its context); \"fresh\" starts a new session with the same address and folder, from its original brief and its TODO.md / NOTES.md. Use fresh when its notes and its reported files disagree or it looked confused. A continue whose conversation can no longer be restored starts fresh by itself (the result says so). Counts against the 3-worker cap. Never relaunch a paused worker's task with launch_cli.",
    inputSchema: {
      type: "object",
      properties: {
        worker: { type: "string", description: "The worker's address (or its id, e.g. w2)" },
        mode: { type: "string", enum: ["continue", "fresh"] },
        message: { type: "string", description: "What it should do first" },
      },
      required: ["worker", "mode"],
    },
  },
  {
    name: "end_run",
    path: "end",
    description: "Remove the git worktrees of stopped workers whose branches are merged into HEAD, and close the run when nothing is left. Returns what was removed and what was kept, and why.",
    inputSchema: { type: "object", properties: {} },
  },
];

const WORKER_TOOLS = [
  {
    name: "report",
    path: "report",
    description: "Report your status to the orchestrator. Call it when you start, when you are blocked, and when you are done or failed. Never end a turn without reporting.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["started", "blocked", "done", "failed", "paused"] },
        summary: { type: "string", description: "What happened, in a few sentences" },
        filesChanged: { type: "array", items: { type: "string" } },
        verified: { type: "string", description: "The one check you ran (one line)" },
        open: { type: "string", description: "What is still open or needs a decision" },
      },
      required: ["status", "summary"],
    },
  },
];

const MESSAGING_TOOLS = [
  {
    name: "SendMessage",
    path: "send-message",
    description: "Send a message to another session of this orchestration run, addressed by its name (the orchestrator's address, or a worker's). It arrives in the recipient's conversation as \"[message from <your name>] …\": a busy recipient reads it after its current tool calls, an idle one starts a turn with it. Returns the recipient's address and how it was delivered.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "The recipient's address (ListAgents lists them)" },
        message: { type: "string", description: "The message, self-contained" },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "ListAgents",
    path: "list-agents",
    description: "List the sessions of this orchestration run you can message: your own address, and every member's address, role, state and last report.",
    inputSchema: { type: "object", properties: {} },
  },
];

const roleTools = role === "orchestrator" ? ORCHESTRATOR_TOOLS : role === "worker" ? WORKER_TOOLS : [];
const tools = roleTools.length && engine === "sdk" ? [...roleTools, ...MESSAGING_TOOLS] : roleTools;

const { Server } = await import(pathToFileURL(path.join(sdkBase, "server", "index.js")).href);
const { StdioServerTransport } = await import(pathToFileURL(path.join(sdkBase, "server", "stdio.js")).href);
const types = await import(pathToFileURL(path.join(sdkBase, "types.js")).href);

const server = new Server(
  { name: "orchestrator", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(types.CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    return { content: [{ type: "text", text: JSON.stringify({ error: `tool ${name} not found` }) }], isError: true };
  }
  try {
    const result = await callDashboard(tool.path, args || {});
    return {
      content: [{ type: "text", text: JSON.stringify(result.error ? { error: result.error } : result, null, 2) }],
      isError: !!result.error,
    };
  } catch (err) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
  }
});

function callDashboard(route, args) {
  const body = JSON.stringify({ instanceId, ...args });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: parseInt(dashboardPort, 10),
      path: `/api/orchestration/${route}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-Vistaclair-Internal": authToken,
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk.toString(); });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`bad response (${res.statusCode})`)); }
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error("dashboard timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

await server.connect(new StdioServerTransport());
