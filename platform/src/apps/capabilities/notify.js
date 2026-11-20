// Capability: notify — `toast.show` / `showToast` — dashboard-level toasts with history
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

const { core } = require('../core-services');

async function toast(app, params) {
  const message = params.message != null ? params.message
    : [params.title, params.body].filter(Boolean).join(' — ');
  if (core.broadcaster) core.broadcaster.broadcast({
    type: 'toast:push',
    sender: params.sender || app.name,
    message: String(message || ''),
    title: params.title || '',
    level: params.level || 'info',
    duration: typeof params.duration === 'number' ? params.duration : undefined,
    ts: Date.now(),
  });
  return true;
}

module.exports = {
  key: 'notify',
  title: 'Notifications',
  core: true,
  gated: false,
  methods: ['toast.show', 'notify'],
  runtime: ['showToast'],
  ctx: ['notify'],
  keywords: /\b(toast|notification|notify)\b/i,
  summary: '`toast.show` / `showToast` — dashboard-level toasts with history',
  migration: 'In-app toasts only visible inside the iframe → `showToast()` / `toast.show`. Replace legacy `notify` calls with `toast.show`.',

  buildCtx(app) {
    const name = app.name;
    const broadcaster = app.broadcaster;
    return {
      notify: (title, body, level) => broadcaster?.broadcast({ type: 'toast:push', sender: name, title: title || '', message: body || '', level: level || 'info', ts: Date.now() }),
    };
  },

  bridge: {
    // Unified toast: surfaced in the core Vistaclair header toast system.
    // 'notify' is the legacy alias (title/body); 'toast.show' uses message/sender.
    'toast.show': toast,
    'notify': toast,
  },

  horst: {
    lane: {
      card: {
        'toast.show': { missing: 'a dashboard toast from Horst has no kind; he reaches the owner in chat and on Telegram' },
        notify: { missing: 'a dashboard toast from Horst has no kind; he reaches the owner in chat and on Telegram' },
      },
    },
  },
};
