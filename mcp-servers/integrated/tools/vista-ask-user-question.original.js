// Internal tool: proxies AskUserQuestion forms through the dashboard UI.
import { z } from "zod";

export default function register(server) {
  server.tool(
    "vista-AskUserQuestion",
    "Internal: handles AskUserQuestion forms via the dashboard UI.",
    {
      questions: z.array(z.any()).describe("Questions to ask the user"),
      title: z.string().optional(),
      description: z.string().optional(),
      submitLabel: z.string().optional(),
      cancelLabel: z.string().optional(),
    },
    async (input, extra) => {
      const http = await import("http");
      const dashPort = process.env.VISTACLAIR_DASHBOARD_PORT || "3457";
      // The session token as a header; else VISTACLAIR_AUTH_TOKEN, which an older
      // server (still running while this file is already updated) fills with the
      // owner token and reads from the body. A current server's session environment never holds the owner token.
      const sessionToken = process.env.VISTACLAIR_SESSION_TOKEN || "";
      const legacyToken = sessionToken ? "" : (process.env.VISTACLAIR_AUTH_TOKEN || "");
      const instanceId = process.env.VISTACLAIR_INSTANCE_ID || "";

      const formData = { ...input };
      const questions = input.questions || [];

      const body = JSON.stringify({ ...(legacyToken ? { token: legacyToken } : {}), instanceId, formData, questions });

      return new Promise((resolve) => {
        // The call ends without an answer (4 h, or Claude Code cancels it: an
        // interrupt, its MCP tool timeout): destroy the socket, so the
        // dashboard's res 'close' marks the form expired instead of live.
        const giveUp = () => {
          clearTimeout(timeout);
          try { req.destroy(); } catch {}
          resolve({ content: [{ type: "text", text: JSON.stringify({ cancelled: true }) }] });
        };
        const timeout = setTimeout(giveUp, 4 * 60 * 60 * 1000);
        extra?.signal?.addEventListener("abort", giveUp, { once: true });

        const req = http.request({
          hostname: "127.0.0.1",
          port: parseInt(dashPort, 10),
          path: "/api/ask",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            ...(sessionToken ? { "x-vistaclair-session": sessionToken } : {}),
          },
        }, (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk.toString(); });
          res.on("end", () => {
            clearTimeout(timeout);
            try {
              const result = JSON.parse(data);
              if (result.ok) {
                resolve({ content: [{ type: "text", text: JSON.stringify(result.answer) }] });
              } else {
                resolve({ content: [{ type: "text", text: JSON.stringify({ cancelled: true }) }] });
              }
            } catch {
              resolve({ content: [{ type: "text", text: JSON.stringify({ cancelled: true }) }] });
            }
          });
        });

        req.on("error", () => {
          clearTimeout(timeout);
          resolve({ content: [{ type: "text", text: JSON.stringify({ error: "Failed to reach dashboard" }) }] });
        });

        req.write(body);
        req.end();
      });
    }
  );
}
