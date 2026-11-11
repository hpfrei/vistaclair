#!/usr/bin/env node
// MCP Bridge — stdio runner for MCP servers managed by the dashboard.
// Claude Code spawns this: node lib/mcp-bridge.js <slug>
// It imports the server module and connects it via StdioServerTransport.
//
// The SDK is resolved from the server's own node_modules (not the dashboard's).
// The bridge holds no dashboard connection: it used to open an owner-authenticated
// WebSocket to report tool calls, which the dashboard never logged.

import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";
import path from "path";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const slug = process.argv[2] || process.env.VISTACLAIR_SERVER_SLUG || "integrated";
const serverDir = path.join(__dirname, "..", "mcp-servers", slug);

// Decrypt this server's secrets (secrets.enc) into the environment before the
// user's server module loads. The encryption key (.secrets_key) is read from
// disk here — it is never passed via env/cmdline. The dashboard writes only the
// data-home locator + slug into the spawn config, so plaintext secrets never
// touch the shared .mcp.json / ~/.claude.json or any tmp file.
(function loadSecrets() {
  const dataHome = process.env.VISTACLAIR_DATA_HOME;
  if (!dataHome) return;
  try {
    const require = createRequire(import.meta.url);
    const { readSecretFile } = require("../src/secret-store");
    const encPath = path.join(dataHome, "mcp-servers", slug, "secrets.enc");
    const secrets = readSecretFile(encPath, dataHome, { fallback: {} });
    for (const [k, v] of Object.entries(secrets)) {
      if (k && process.env[k] === undefined) process.env[k] = String(v);
    }
  } catch {}
})();

// --- Main ---

async function main() {
  // Resolve the SDK from the server's own node_modules
  const sdkBase = path.join(serverDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", "stdio.js");
  const { StdioServerTransport } = await import(pathToFileURL(sdkBase).href);

  // Dynamic import of the user's server module (ESM)
  const mod = await import(pathToFileURL(path.join(serverDir, "server.js")).href);
  const server = mod.default;

  if (!server || typeof server.connect !== "function") {
    process.stderr.write(`Error: server.js must export default an McpServer instance\n`);
    process.exit(1);
  }

  // Connect — StdioServerTransport reads from stdin and writes to stdout
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // The client (Claude Code) is gone: nothing can read a result any more. Exit,
  // so an open dashboard request (a pending AskUserQuestion form) closes and
  // the dashboard marks it expired instead of leaving it live for hours.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}

main().catch((err) => {
  process.stderr.write(`MCP bridge error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
