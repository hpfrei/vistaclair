// Capability: exec — `exec`, `spawn`, `spawn.kill` — shell commands and long-running processes
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.

module.exports = {
  key: 'exec',
  title: 'Execution',
  core: true,
  gated: true,
  methods: ['exec', 'spawn', 'spawn.kill'],
  keywords: /\b(shell command|subprocess|spawn a process)\b/i,
  summary: '`exec`, `spawn`, `spawn.kill` — shell commands and long-running processes',

  bridge: {
    'exec': (app, params) => require('../spawn-manager').exec(app, params),
    'spawn': async (app, params, io) => require('../spawn-manager').spawn(app, params, io.emitEvent),
    'spawn.kill': async (app, params) => require('../spawn-manager').kill(params.spawnId),
  },

  // ---- Horst facet: senses, approval-gated kinds -----------------------------
  horst: {
    lane: {
      card: { 'spawn.kill': 'spawn.kill' },
      never: ['exec', 'spawn'],
      why: 'running commands is never Horst\'s (the chat has no shell); he may only stop a spawned process, through a card',
    },
    brief: 'exec: shell commands and long-running processes spawned by apps (killing one is approval-gated)',
    senses: [
      { kind: 'spawn:failed', description: 'A process an app spawned exited with a non-zero code (not killed)', defaultPolicy: 'agenda' },
      { kind: 'toolchain:license-lapsed', description: 'A platform toolchain\'s licence (the unity extra) is not active and the hourly check could not re-activate it — the owner signs in under Apps → Setup → Extras', defaultPolicy: 'notify' },
    ],
    wire({ publish }) {
      const offExit = require('../spawn-manager').onExit((appName, spawnId, code, killed, command) => {
        if (killed || code === 0 || code == null) return;
        publish('spawn:failed', { app: appName, spawnId, code, command: String(command || '').slice(0, 200) },
          { dedupeKey: `spawn:${appName}:${spawnId}`, summary: `Process exited ${code} in ${appName}: ${String(command || '').slice(0, 60)}`.slice(0, 120) });
      });
      // Apps exec the toolchains; the licence check is platform-extras-unity-license.js (once per lapse).
      const offLicence = require('../platform-extras-unity-license').observe((ev) => {
        const why = ev.reason === 'signed-out' ? 'the account is signed out' : `re-activation failed${ev.error ? `: ${ev.error}` : ''}`;
        publish('toolchain:license-lapsed', { toolchain: ev.toolchain, reason: ev.reason, error: ev.error },
          { dedupeKey: `toolchain-license:${ev.toolchain}:${ev.reason}`, summary: `Unity licence not active — ${why}. Sign in under Apps → Setup → Extras → Unity`.slice(0, 200) });
      });
      return () => { offExit?.(); offLicence(); };
    },
    kinds: {
      'spawn.kill': {
        identity: null, // a repeat run is a legitimate retry, never a duplicate
        label: 'Kill spawned process',
        about: 'Sends SIGTERM to a process an app spawned through the platform.',
        ceiling: 'auto+notify',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'spawnId', 'any');
          if (!require('../spawn-manager').spawned.has(String(p.spawnId))) throw new Error(`no running spawn "${p.spawnId}"`);
        },
        describe: (p) => `Kill spawned process ${p.spawnId}${p.app ? ` (${p.app})` : ''}`,
        execute(p) {
          require('../spawn-manager').kill(String(p.spawnId));
          return { ok: true, summary: `Spawn ${p.spawnId} killed` };
        },
      },

      // Phase 6 remediation: the spawn:failed sense finally has a matching
      // action — spawn the command again in the app's directory. The crashed
      // spawn's entry is gone (exited), so the payload carries the command
      // explicitly (frozen in the proposal — what you approve is what runs).
      'spawn.restart': {
        identity: null, // a repeat run is a legitimate retry, never a duplicate
        label: 'Restart crashed process',
        about: 'Spawns a command again in an app\'s directory after its process exited non-zero. Output streams to the app as the usual spawn events.',
        ceiling: 'auto+notify',
        // Only ever staged for a process that ALREADY exited, so restarting
        // converges on "the process is running" rather than accumulating
        // duplicates. The command is frozen in the proposal — what would have
        // been approved is exactly what runs.
        defaultLevel: 'auto+notify',
        idempotent: true,
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'app'); req(p, 'command');
          if (!require('../app-manager').readManifest(p.app)) throw new Error(`unknown app "${p.app}"`);
          if (p.args != null && !Array.isArray(p.args)) throw new Error('args must be an array');
        },
        describe: (p) => `Restart process in "${p.app}": ${String(p.command).slice(0, 60)}`,
        execute(p) {
          const path = require('path');
          const appManager = require('../app-manager');
          const { core } = require('../core-services');
          // Same event routing as a bridge spawn: the owning app's iframe gets
          // spawn:stdout/stderr/exit via app:bridge:event.
          const emitEvent = (event, data) => {
            if (core.broadcaster) core.broadcaster.broadcast({ type: 'app:bridge:event', appName: p.app, event, data });
          };
          const app = { name: p.app, dir: path.join(appManager.APPS_DIR, p.app) };
          const r = require('../spawn-manager').spawn(app, { command: p.command, args: p.args || [] }, emitEvent);
          return { ok: true, ...r, summary: `Spawned "${String(p.command).slice(0, 60)}" in ${p.app} (spawn ${r.spawnId})` };
        },
      },
    },
  },
};
