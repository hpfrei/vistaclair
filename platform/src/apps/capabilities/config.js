// Capability: config — the named configurations Horst may read and propose to change: one registry, one write discipline (`config.set`), one editor
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.
//
// This capability is PLATFORM-facing: apps get no ctx members or bridge
// methods from it (the tag vocabulary stays `ctx.email.labels.*`). It exists
// so everything Horst may change about how he reads the user's world lives in
// ONE table with ONE write path: the leash (dials, paused, models, spend) is
// owner-only and is not here; a configuration (tags, document types, triage
// thresholds) is here, readable by Horst through `config_list` / `config_get`
// and changed only through the `config.set` proposal — or by the owner in
// Horst Settings, which posts the same patch through `set()`.
//
// A patch is the unit of change. For a `list` configuration it is
//   { add: [item], remove: [id | name], update: [{ id, ...fields }] }
// and for a `fields` configuration a shallow object of the fields to set.
// `validatePatch` is the whole contract; `set` applies what it accepted.

const LIST_OPS = ['add', 'remove', 'update'];

const engine = () => require('../email-engine');
const settings = () => require('../agent/horst-settings');

// Lazy, so requiring the registry never touches the engines. Every entry:
//   schema  what the editor renders and validatePatch enforces
//   read()  the current value, in the shape the schema describes
//   apply(patch, value)  performs an already-validated patch
const REGISTRY = {
  'email.tags': {
    title: 'Tags',
    about: 'The tag vocabulary every mail surface, the search operator and the classifier share.',
    schema: {
      type: 'list', max: 24, key: 'name',
      item: { name: { type: 'string', max: 60 }, color: { type: 'string', optional: true, pattern: '^#[0-9a-fA-F]{6}$' }, endDate: { type: 'string', optional: true, pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
    },
    read: () => engine().listLabels().map((l) => ({ id: l.id, name: l.name, color: l.color, ...(l.endDate ? { endDate: l.endDate } : {}) })),
    apply(patch, value) {
      const e = engine();
      const idOf = (ref) => resolveListItem(value, ref, 'name')?.id;
      for (const ref of patch.remove || []) { const id = idOf(ref); if (id) e.removeLabel(id); }
      for (const { id, ...fields } of patch.update || []) e.updateLabel(id, fields);
      for (const item of patch.add || []) e.addLabel(item); // an existing name is a no-op
    },
  },
  'horst.docTypes': {
    title: 'Document types',
    about: 'The filing vocabulary for scanned attachments; "other" is the classifier\'s fallback bucket and stays.',
    schema: { type: 'list', max: 24, item: { type: 'string', max: 64 }, locked: ['other'] },
    read: () => settings().get().docTypes.slice(),
    apply(patch, value) {
      const s = settings();
      const drop = new Set((patch.remove || []).map((r) => String(r).toLowerCase()));
      const next = value.filter((t) => !drop.has(String(t).toLowerCase())).concat(patch.add || []);
      s.set({ docTypes: s.sanitizeDocTypes(next) });
    },
  },
  'horst.triage': {
    title: 'Email triage',
    about: 'How the mail sweep works: the spam thresholds, whether spam is filed, how old a message may be to enter the work queue, how many one sweep classifies.',
    schema: {
      type: 'fields',
      fields: {
        spamThresholdSuspect: { type: 'number', min: 0, max: 100, about: 'spamScore at which a message is suspect (gates outward-facing acts)' },
        spamThresholdSpam: { type: 'number', min: 0, max: 100, about: 'spamScore at which a message is spam (gates everything else)' },
        autoFileSpam: { type: 'boolean', about: 'move a new INBOX message judged spam to the Spam folder' },
        triageWindowHours: { type: 'number', min: 1, max: 720, about: 'only mail newer than this enters the work queue' },
        triageBatch: { type: 'number', min: 1, max: 25, about: 'messages classified per heartbeat sweep' },
      },
    },
    read: () => { const s = settings().get(); return { spamThresholdSuspect: s.spamThresholdSuspect, spamThresholdSpam: s.spamThresholdSpam, autoFileSpam: s.autoFileSpam, triageWindowHours: s.triageWindowHours, triageBatch: s.triageBatch }; },
    apply(patch) { settings().set(patch); },
  },
  'horst.notify': {
    title: 'Event reminders',
    about: 'A Telegram reminder before each timed calendar event, kept true (countdown, moved, cancelled, ended) until the event is over.',
    schema: {
      type: 'fields',
      fields: {
        eventReminders: { type: 'boolean', about: 'send event reminders to the control chat' },
        eventLeadMinutes: { type: 'number', min: 1, max: 240, about: 'minutes before the start the reminder is sent' },
      },
    },
    read: () => { const s = settings().get(); return { eventReminders: s.eventReminders, eventLeadMinutes: s.eventLeadMinutes }; },
    apply(patch) { settings().set(patch); },
  },
};

function entry(key) {
  const def = REGISTRY[key];
  if (!def) throw new Error(`unknown configuration "${key}" (${Object.keys(REGISTRY).join(', ')})`);
  return def;
}

// A list item by id or, case-insensitively, by name (string lists: by value).
function resolveListItem(value, ref, key) {
  const r = String(ref ?? '').trim().toLowerCase();
  if (!r) return null;
  return value.find((it) => (typeof it === 'string' ? it.toLowerCase() === r : it.id === ref || String(it[key] || '').toLowerCase() === r)) ?? null;
}

function checkField(name, spec, v) {
  if (v == null) { if (spec.optional) return; throw new Error(`${name} is required`); }
  if (spec.type === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
    if (spec.min != null && v < spec.min) throw new Error(`${name} must be at least ${spec.min}`);
    if (spec.max != null && v > spec.max) throw new Error(`${name} must be at most ${spec.max}`);
  } else if (spec.type === 'boolean') {
    if (typeof v !== 'boolean') throw new Error(`${name} must be true or false`);
  } else {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} must be a non-empty string`);
    if (spec.max != null && v.trim().length > spec.max) throw new Error(`${name} is too long (${spec.max} max)`);
    if (spec.pattern && !new RegExp(spec.pattern).test(v)) throw new Error(`${name} is not in the expected form`);
  }
}

function checkItem(schema, item, what) {
  if (schema.item.type) return checkField(what, schema.item, item);
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${what} must be an object`);
  for (const [f, spec] of Object.entries(schema.item)) checkField(`${what}.${f}`, spec, item[f]);
  for (const f of Object.keys(item)) if (!schema.item[f]) throw new Error(`${what}.${f} is not a field of this configuration`);
}

// Throws on anything `set` would refuse; a patch that passes here applies.
// Defensive on the empty object: governance runs every kind's validate.
function validatePatch(key, patch) {
  const def = entry(key);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('patch must be an object');
  const { schema } = def;
  if (schema.type === 'fields') {
    const keys = Object.keys(patch);
    if (!keys.length) throw new Error('patch sets no field');
    for (const k of keys) {
      if (!schema.fields[k]) throw new Error(`"${k}" is not a field of ${key} (${Object.keys(schema.fields).join(', ')})`);
      checkField(k, schema.fields[k], patch[k]);
    }
    return;
  }
  for (const k of Object.keys(patch)) if (!LIST_OPS.includes(k)) throw new Error(`"${k}" is not a list operation (${LIST_OPS.join(', ')})`);
  for (const op of LIST_OPS) if (patch[op] != null && !Array.isArray(patch[op])) throw new Error(`${op} must be an array`);
  const add = patch.add || []; const remove = patch.remove || []; const update = patch.update || [];
  if (!add.length && !remove.length && !update.length) throw new Error('patch changes nothing');
  const value = def.read();
  const locked = new Set((schema.locked || []).map((s) => s.toLowerCase()));
  add.forEach((it, i) => checkItem(schema, it, `add[${i}]`));
  for (const ref of remove) {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('remove takes ids or names');
    if (locked.has(ref.trim().toLowerCase())) throw new Error(`"${ref}" cannot be removed`);
  }
  for (const it of update) {
    if (schema.item.type) throw new Error(`${key} items have no fields to update — remove and add instead`);
    if (!it || typeof it !== 'object' || typeof it.id !== 'string') throw new Error('update takes { id, ...fields }');
    if (!value.some((v) => v.id === it.id)) throw new Error(`no ${key} item with id "${it.id}"`);
    const { id, ...fields } = it;
    if (!Object.keys(fields).length) throw new Error(`update of "${id}" changes nothing`);
    for (const [f, spec] of Object.entries(fields.name != null ? schema.item : { ...schema.item, name: { ...schema.item.name, optional: true } })) {
      if (f in fields) checkField(`update.${f}`, spec, fields[f]);
    }
    for (const f of Object.keys(fields)) if (!schema.item[f]) throw new Error(`update.${f} is not a field of this configuration`);
  }
  const removed = remove.filter((r) => resolveListItem(value, r, schema.key)).length;
  const added = add.filter((it) => !resolveListItem(value, typeof it === 'string' ? it : it[schema.key], schema.key)).length;
  if (value.length - removed + added > schema.max) throw new Error(`${key} holds at most ${schema.max} items`);
}

const quote = (s) => `'${String(s)}'`;

// One line the owner reads on the card: "Tags: add 'Bills · IT services'".
function describePatch(p) {
  const key = p && p.key; const patch = (p && p.patch) || {};
  const def = REGISTRY[key];
  if (!def || typeof patch !== 'object') return 'Configuration change';
  const parts = [];
  if (def.schema.type === 'fields') {
    for (const [k, v] of Object.entries(patch)) parts.push(`${k} → ${v}`);
  } else {
    const names = (items, f) => items.map((it) => quote(typeof it === 'string' ? it : it?.[f] ?? it?.id ?? '?')).join(', ');
    if (Array.isArray(patch.add) && patch.add.length) parts.push(`add ${names(patch.add, 'name')}`);
    if (Array.isArray(patch.remove) && patch.remove.length) parts.push(`remove ${names(patch.remove, 'name')}`);
    if (Array.isArray(patch.update) && patch.update.length) parts.push(`update ${names(patch.update, 'name')}`);
  }
  return `${def.title}: ${parts.length ? parts.join('; ') : 'no change'}`;
}

function list() {
  return Object.entries(REGISTRY).map(([key, d]) => ({ key, title: d.title, about: d.about, schema: d.schema }));
}

function get(key) {
  const d = entry(key);
  return { key, title: d.title, about: d.about, schema: d.schema, value: d.read(), initialised: key.startsWith('horst.') ? settings().isReady() : true };
}

// `via` names the path ('horst' for an approved proposal, 'ui' for the
// Settings editor); it is reported, not used for anything else.
function set(key, patch, via = 'ui') {
  const def = entry(key);
  validatePatch(key, patch);
  const before = def.read();
  def.apply(patch, before);
  return { key, via, before, after: def.read(), summary: describePatch({ key, patch }) };
}

module.exports = {
  key: 'config',
  title: 'Configurations',
  core: false,
  gated: false,
  methods: [],
  summary: 'Named configurations — platform-side, no app API',
  keywords: /\b(named configurations?|config registry|triage thresholds?|document types?)\b/i,

  list, get, validatePatch, set, describePatch,

  // ---- Horst facet: read tools, one approval-pinned kind ---------------------
  horst: {
    lane: { default: 'never', why: 'no app-facing members; config_list / config_get and config.set are platform-only' },
    brief: 'config: the named configurations you may read (config_list / config_get) and propose to change (config.set): tags, document types, triage thresholds, event reminders',
    tools: [
      {
        def: {
          name: 'config_list',
          description: 'The named configurations Horst may read and propose to change: key, title, what it is for, and the schema a config.set patch must follow. Read-only — changes go through the config.set proposal.',
          inputSchema: { type: 'object', properties: {} },
        },
        handler: async () => require('../horst-facet').textResult(list()),
      },
      {
        def: {
          name: 'config_get',
          description: 'One configuration\'s current value with its schema (call before staging config.set so a patch names existing items). Read-only.',
          inputSchema: { type: 'object', properties: {
            key: { type: 'string', description: 'The configuration key (config_list has them).' },
          }, required: ['key'] },
        },
        handler: async (args) => {
          const { textResult } = require('../horst-facet');
          try { return textResult(get(String(args.key || ''))); } catch (err) { return textResult(err.message); }
        },
      },
    ],
    kinds: {
      'config.set': {
        // One item added, removed or updated, or one set of fields, is one act:
        // "add tag Bills" from chat and from the sweep's sightings dedupe.
        identity: (p) => require('../governance/horst-identity').configKey(p),
        label: 'Change a configuration',
        about: 'Applies one patch to a named configuration (tags, document types, triage thresholds) — the vocabulary and thresholds Horst reads the user\'s world through.',
        pinNote: 'A configuration shapes how Horst reads everything from then on and there is no undo executor — always human-confirmed.',
        ceiling: 'propose',
        defaultLevel: 'propose',
        notify: 'none',
        validate(p) {
          const { req } = require('../horst-facet');
          validatePatch(req(p, 'key'), req(p, 'patch', 'any'));
        },
        describe: describePatch,
        execute: (p) => set(p.key, p.patch, 'horst'),
      },
    },
  },
};
