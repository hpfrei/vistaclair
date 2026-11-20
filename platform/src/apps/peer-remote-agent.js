// The `peer.session.launch` kind (docs/remote-sessions.md "The card"):
// payload, card, approval surfaces and executor. capabilities/fleet.js
// declares the kind and delegates here.
//
// Every session an agent wants on a linked slave is one proposal, ceiling-pinned
// to propose, whose card shows the raw request: slave, app, mode, billing, the
// prompt verbatim, who asked. Only the owner's approval launches.
//
//   Horst          stages the kind through his propose markers (mode simple
//                  or orchestrator; launch origin { kind: 'horst', ref:
//                  <proposal id> }, through peer-remote-master.launch).
//   run member     an orchestrator's launch_cli({ host }) reaches
//                  peer-remote-host.js (core's host provider), which files the
//                  card (mode worker, proposal origin ORIGIN) and waits;
//                  approving it hands the launch back to that module.

const KIND = 'peer.session.launch';
const ORIGIN = 'peer-remote-host';       // proposal.origin of a card a run member's launch filed
const PROMPT_CAP = 32 * 1024;            // peer-remote-master's PROMPT_CAP
const TITLE_CAP = 120;
const MODES = new Set(['simple', 'orchestrator', 'worker']);
const AUTHS = new Set(['subscription', 'apikey']);
const ORIGIN_KINDS = new Set(['horst', 'orchestrator']);
const SPEC_KEYS = ['peer', 'mode', 'app', 'prompt', 'auth', 'model', 'title'];
const PAYLOAD_KEYS = new Set([...SPEC_KEYS, 'origin']);
const APP_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;   // the slave's app rule (docs/federation.md)
const MODEL_RE = /^[A-Za-z0-9._-]{1,80}(\[1m\])?$/;
// Surfaces that render the whole prompt: the Horst tab's full card ('ui-full',
// not its timeline row or queue preview, which are plain 'ui') and the Mini
// App's detail view; the Telegram card only when the prompt fits in what it shows.
const FULL_VIEWS = new Set(['ui-full', 'miniapp']);

// Replaceable for tests: the master half and the host provider.
let deps = {
  master: () => require('./peer-remote-master'),
  host: () => require('./peer-remote-host'),
};

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const tgLimit = () => require('./governance/horst-cards').TEXT_BODY_LIMIT;
// What the owner approves must be all there to read: no character the card
// would have to show as ⟨U+XXXX⟩ (text-safety.js).
const invisibleIn = (s) => {
  const { invisibleChars, codePointLabel } = require('./text-safety');
  const cps = invisibleChars(s);
  return cps.length ? codePointLabel(cps[0]) : null;
};

// Everything but `peer` (fleet.js checks it against the pairing store).
function checkPayload(p) {
  if (!isPlain(p)) throw new Error('payload must be an object');
  for (const k of Object.keys(p)) if (!PAYLOAD_KEYS.has(k)) throw new Error(`unknown field "${k}"`);
  if (!MODES.has(p.mode)) throw new Error('mode must be "simple", "orchestrator" or "worker"');
  if (typeof p.app !== 'string' || !APP_RE.test(p.app)) throw new Error('app must be an app name (the slave\'s app folder)');
  if (typeof p.prompt !== 'string' || !p.prompt.trim()) throw new Error('prompt must be non-empty text');
  if (p.prompt.length > PROMPT_CAP) throw new Error(`prompt is ${p.prompt.length} characters; the limit is ${PROMPT_CAP}`);
  const hidden = invisibleIn(p.prompt);
  if (hidden) throw new Error(`prompt contains an invisible or control character (${hidden}): only text the owner can read is launched (newlines and tabs are fine)`);
  if (!AUTHS.has(p.auth)) throw new Error('auth must be "subscription" or "apikey"');
  if (p.model != null && (typeof p.model !== 'string' || !MODEL_RE.test(p.model))) throw new Error('bad model name');
  if (p.title != null && (typeof p.title !== 'string' || p.title.length > TITLE_CAP)) throw new Error(`title must be text of at most ${TITLE_CAP} characters`);
  if (p.title != null && invisibleIn(p.title)) throw new Error(`title contains an invisible or control character (${invisibleIn(p.title)})`);
  if (p.origin != null) {
    const o = p.origin;
    if (!isPlain(o) || !ORIGIN_KINDS.has(o.kind)) throw new Error('origin.kind must be "horst" or "orchestrator"');
    for (const k of Object.keys(o)) if (!['kind', 'ref', 'title', 'address', 'member'].includes(k)) throw new Error(`unknown field "origin.${k}"`);
    for (const k of ['ref', 'title', 'address', 'member']) {
      if (o[k] != null && (typeof o[k] !== 'string' || o[k].length > 200)) throw new Error(`origin.${k} must be text`);
      if (o[k] != null && invisibleIn(o[k])) throw new Error(`origin.${k} contains an invisible or control character`);
    }
  }
  if (p.mode === 'worker' && !(isPlain(p.origin) && p.origin.kind === 'orchestrator' && p.origin.ref && p.origin.member)) {
    throw new Error('a worker launch names its run and member');
  }
}

// Who asked — from the proposal's own origin, never from the payload alone:
// only a card peer-remote-host filed (origin ORIGIN, no app) speaks for a run.
function requester(p, proposal) {
  const o = isPlain(p && p.origin) ? p.origin : {};
  if (proposal && proposal.origin === ORIGIN && !proposal.app && o.kind === 'orchestrator' && o.ref) {
    const name = o.title || o.address || 'orchestrator session';
    const member = o.member ? ` · member ${o.member}` : '';
    return { kind: 'orchestrator', ref: o.ref, label: `Orchestrator "${name}" · run ${o.ref}${member}` };
  }
  return { kind: 'horst', ref: proposal && proposal.id ? proposal.id : null, label: `Horst${proposal && proposal.origin ? ` (${proposal.origin})` : ''}` };
}

function billingText(auth) {
  return auth === 'apikey'
    ? 'API key — billed per token on the slave\'s key'
    : 'Claude subscription (the slave\'s login)';
}

function describe(p) {
  const what = p.mode === 'worker' ? 'run worker' : `${p.mode} session`;
  return `Launch a ${what} for app "${p.app}" on slave "${p.peer}" (${p.auth === 'apikey' ? 'API key, per-token cost' : 'subscription'})`;
}

function card(p, proposal) {
  const who = requester(p, proposal);
  const worker = p.mode === 'worker';
  const prompt = String(p.prompt || '');
  const warn = [
    p.auth === 'apikey' ? 'Billed per token to the slave\'s API key.' : null,
    prompt.length > tgLimit() ? `The ${worker ? 'task' : 'prompt'} is longer than a Telegram card shows: approve it in the Mini App or on the Horst tab's full card, where it is shown in full.` : null,
  ].filter(Boolean).join(' ');
  return {
    render: 'generic',
    icon: '🛰',
    title: worker ? `Remote worker on "${p.peer}"` : `Remote ${p.mode} session on "${p.peer}"`,
    subtitle: `app ${p.app}`,
    accent: p.auth === 'apikey' ? 'warn' : null,
    fields: [
      { label: 'Slave', kind: 'text', value: p.peer },
      { label: 'App', kind: 'text', value: p.app },
      { label: 'Mode', kind: 'text', value: worker ? 'worker of a run on this master' : p.mode },
      { label: 'Billing', kind: 'text', value: billingText(p.auth) },
      { label: 'Model', kind: 'text', value: p.model || '' },
      { label: 'Title', kind: 'text', value: p.title || '' },
      { label: 'Requested by', kind: 'text', value: who.label },
      { label: worker ? 'Task' : 'Prompt', kind: 'code', value: prompt, chars: prompt.length, verbatim: true },
    ],
    warn: warn || null,
    footer: worker
      ? 'Approving starts this worker on the slave with exactly this task. Its orchestrator then talks to it (SendMessage) without another card; its questions come to you here.'
      : 'Approving launches exactly this prompt on the slave. Its questions come to you here; agents cannot prompt it again.',
  };
}

// The owner never approves a prompt they could not read whole: an approval
// counts only from a surface that rendered all of it (governance.decide).
function approveFrom(proposal, via) {
  const n = String((proposal && proposal.payload && proposal.payload.prompt) || '').length;
  if (FULL_VIEWS.has(via)) return null;
  if (via === 'telegram') {
    return n > tgLimit()
      ? `The prompt is ${n} characters and the Telegram card shows ${tgLimit()}: approve it in the Mini App or on the Horst tab's full card, where it is shown in full.`
      : null;
  }
  if (via === 'ui') return 'Open the full card (Horst tab, Approvals) to approve a remote session: its prompt is shown in full there.';
  return `A remote session is approved only where its prompt is shown in full (the Horst tab's full card, the Mini App, or a Telegram card it fits on), not via "${via}".`;
}

async function execute(p, proposal) {
  const who = requester(p, proposal);
  // A run member: the waiting launch_cli takes it from here.
  if (p.mode === 'worker') {
    if (who.kind !== 'orchestrator') throw new Error('a worker launch is filed only by a run\'s launch_cli');
    return deps.host().approved(p, proposal);
  }
  const spec = { mode: p.mode, app: p.app, prompt: p.prompt, auth: p.auth };
  if (p.model) spec.model = p.model;
  if (p.title) spec.title = p.title;
  const origin = { kind: 'horst', ...(who.ref ? { ref: String(who.ref) } : {}) };
  let r;
  try {
    r = await deps.master().launch(p.peer, spec, origin);
  } catch (err) {
    throw new Error(`launch on "${p.peer}" failed${err && err.code ? ` (${err.code})` : ''}: ${err && err.message}`);
  }
  return { ok: true, summary: `Remote ${p.mode} session for "${p.app}" started on "${p.peer}" (tab ${r.tabId})` };
}

module.exports = {
  KIND, ORIGIN, PROMPT_CAP, TITLE_CAP, APP_RE,
  checkPayload, describe, card, execute, requester, approveFrom,
  // tests
  _setDeps(over) { deps = { ...deps, ...over }; },
};
