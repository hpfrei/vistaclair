// Capability: tasks — `tasks.list/kill` — inspect and stop spawned processes
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

module.exports = {
  key: 'tasks',
  title: 'Background Tasks',
  core: true,
  gated: false,
  methods: ['tasks.list', 'tasks.kill'],
  prefixes: ['tasks.'],
  keywords: /\b(running tasks|kill a process)\b/i,
  summary: '`tasks.list/kill` — inspect and stop spawned processes',

  bridge: {
    'tasks.list': async () => require('../spawn-manager').listTasks(),
    'tasks.kill': async (app, params) => {
      const { taskType, taskId } = params;
      if (taskType === 'spawn') {
        require('../spawn-manager').kill(taskId);
      } else if (taskType === 'cron') {
        require('../platform-cron').removeJob(taskId);
      }
      return true;
    },
  },

  // ---- Horst facet: read-only tools ------------------------------------------
  horst: {
    lane: {
      direct: { 'tasks.list': 'tasks_list' },
      card: { 'tasks.kill': 'spawn.kill' },
    },
    tools: [
      {
        def: {
          name: 'tasks_list',
          description: 'Processes apps have spawned through the platform (spawnId, app, pid, command, started, last output lines) and the app-scoped cron jobs. Read-only — stopping one goes through the spawn.kill / cron.set proposals.',
          inputSchema: { type: 'object', properties: {
            app: { type: 'string', description: 'Only this app\'s tasks.' },
          } },
        },
        handler: async (args) => {
          const { textResult } = require('../horst-facet');
          const all = require('../spawn-manager').listTasks();
          const list = Array.isArray(all) ? all : (all.spawns || all.tasks || []);
          const rows = list
            .filter((t) => !args.app || t.appName === args.app)
            .map((t) => ({ ...t, recentOutput: Array.isArray(t.recentOutput) ? t.recentOutput.slice(-5).join('').slice(-800) : undefined }));
          return textResult(rows.length ? rows : 'No running tasks.');
        },
      },
    ],
  },
};
