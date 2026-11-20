// Capability: tools — register AI-callable tools; `expose: self|platform|apps`
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

module.exports = {
  key: 'tools',
  title: 'MCP Tools',
  core: true,
  gated: false,
  methods: [],
  ctx: ['registerTools', 'onToolCall', 'tools'],
  keywords: /\b(mcp tool|ai-callable|register(ing)? tools?)\b/i,
  summary: 'register AI-callable tools; `expose: self|platform|apps`',
  visibility: { standalone: false },

  buildCtx(app) {
    const appTools = require('../app-tools');
    const name = app.name;
    const members = {
      registerTools: (toolDefs) => appTools.registerAppTools(name, toolDefs),
      onToolCall: (toolName, handler) => appTools.registerAppToolHandler(name, toolName, handler),
    };
    // Call another app's tool (requires that tool to have expose: 'apps').
    // In-process; lazy-mounts a stopped in-process target. A job tool answers
    // with { structuredContent: { jobId, status: 'running' } } when it outlives
    // `_wait`; its outcome reaches onJobDone (durable: queued until a handler
    // is registered, across restarts), its questions onJobQuestion.
    const jobs = () => require('../app-tool-jobs');
    const me = `app:${name}`;
    members.tools = {
      call: (targetApp, tool, args) => appTools.callCrossAppTool(name, targetApp, tool, args || {}),
      callAndWait: (targetApp, tool, args) => appTools.callCrossAppTool(name, targetApp, tool, args || {}, { wait: Infinity }),
      onJobDone: (handler) => jobs().onJobDone(name, handler),
      onJobQuestion: (handler) => jobs().onJobQuestion(name, handler),
      job: (id) => jobs().get(id, me),
      cancel: (id) => jobs().cancel(id, me),
      reply: (id, text) => jobs().reply(id, text, me),
    };
    return members;
  },

  // ---- Horst facet: the confirm card for a job tool called from owner chat --
  horst: {
    lane: {
      card: { tools: 'app.tool.job' },
      never: ['registerTools', 'onToolCall'],
      why: 'quick app tools are already in the chat (mcp__app-tools__*); a long-running one is staged as app.tool.job. Registering tools is an app\'s own',
    },
    brief: 'tools: long-running app tools (marked "Long-running") start only after the owner taps Start on a card; the result, its files and any question come back into this conversation',
    kinds: {
      // Staged by agent/horst-jobs.js when an owner chat turn calls a job
      // tool (app-tools.callAppToolHandler → app-tool-jobs.stageForHorst);
      // the launcher starts it on the horst route of app-tool-jobs.
      'app.tool.job': {
        identity: null, // each request is its own run, never a duplicate
        label: 'Start long-running app tool',
        about: 'Starts a long-running app tool Horst called from your chat. It runs in the background; progress, questions and the result (with its files) come back to that chat.',
        pinNote: 'A multi-minute run that may spend and write is always the owner\'s tap — Horst never starts one on his own.',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'app'); req(p, 'tool'); req(p, 'conversationId');
          if (!p.args || typeof p.args !== 'object' || Array.isArray(p.args)) throw new Error('args must be an object');
          if (p.chatId != null && !/^-?\d+$/.test(String(p.chatId))) throw new Error('chatId must be a Telegram chat id');
          if (p.plan !== undefined && (typeof p.plan !== 'string' || !p.plan.trim() || p.plan.length > 500)) throw new Error('plan must be a non-empty string of at most 500 characters');
          if ('_plan' in p.args || '_wait' in p.args) throw new Error('args must not carry the reserved _plan / _wait');
          const tool = require('../app-tools').getToolsForApp(p.app).find((t) => t.name === p.tool);
          if (!tool) throw new Error(`no tool "${p.tool}" in app "${p.app}"`);
          if (tool.kind !== 'job') throw new Error(`"${p.app}__${p.tool}" is not a long-running (job) tool`);
        },
        describe: (p) => `Start ${p.app} › ${p.tool}: ${p.plan || argsLine(p.args) || 'no plan given'}`.slice(0, 200),
        // Horst's plan (payload.plan, the reserved `_plan` of his call) leads
        // every projection; the raw arguments follow it.
        card: (p) => ({
          icon: '🛠',
          title: `Start ${p.app} › ${p.tool}`,
          fields: [
            p.plan
              ? { label: 'Plan', kind: 'longtext', value: p.plan, chars: p.plan.length }
              : { label: 'Plan', kind: 'text', value: 'no plan given — check the arguments' },
            { label: 'Arguments', kind: 'code', value: JSON.stringify(p.args || {}, null, 2) },
          ],
          footer: `Long-running — it runs in the background; progress and results: ${p.chatId != null ? 'this Telegram chat' : 'the Horst chat'}`,
        }),
        execute(p, proposal, helpers) {
          const fn = helpers && helpers.launcher ? helpers.launcher('app.tool.job') : null;
          if (!fn) throw new Error('app.tool.job launcher not registered (Horst is not initialized)');
          return fn(p, proposal);
        },
      },
    },
  },
};

// `prompt: "a lighthouse", style: "low-poly"` — the card summary's one line.
function argsLine(args) {
  return Object.entries(args || {}).slice(0, 3)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v.slice(0, 40)) : JSON.stringify(v)}`)
    .join(', ').slice(0, 120);
}
