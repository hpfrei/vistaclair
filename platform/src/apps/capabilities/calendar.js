// Capability: calendar — `calendar.events/get/create/update/delete` — synced Google Calendar
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

// Guests are calendar.invite's alone. Attendees on a write make Google mail
// them (writeQuery: attendees ⇒ sendUpdates=all), which is outward-facing — so
// the auto-capable create/update refuse them, and a `sendUpdates` that would
// notify existing guests, rather than carry an outward act under an inward
// ceiling (G9).
function refuseGuests(p, kind) {
  if (p.attendees !== undefined) throw new Error(`${kind} does not take attendees — inviting guests is calendar.invite`);
  if (p.sendUpdates !== undefined && p.sendUpdates !== 'none') throw new Error(`${kind} does not notify guests — use calendar.invite`);
}

// Addresses from a mixed attendee list (strings or { email }), lowercased.
function guestList(list) {
  return (Array.isArray(list) ? list : [])
    .map((a) => String(typeof a === 'string' ? a : a?.email || '').trim().toLowerCase())
    .filter(Boolean);
}

// Account resolution shared by the calendar action kinds (Horst facet).
function calendarAccountOrThrow(p) {
  const accounts = require('../calendar-engine').calendarAccounts();
  if (!accounts.length) throw new Error('no calendar-enabled Google account connected');
  const account = p.account || accounts[0];
  if (!accounts.includes(account)) throw new Error(`account "${account}" has no calendar access`);
  return account;
}

module.exports = {
  key: 'calendar',
  title: 'Calendar Engine',
  core: false,
  gated: true,
  methods: ['calendar.events', 'calendar.get', 'calendar.create', 'calendar.update', 'calendar.move', 'calendar.delete', 'calendar.listCalendars', 'calendar.selectCalendars', 'calendar.defaultCalendarId', 'calendar.setDefaultCalendar', 'calendar.freeBusy', 'calendar.availability', 'calendar.colors', 'calendar.annotate', 'calendar.annotations', 'calendar.syncStatus', 'calendar.syncNow', 'calendar.subscribe'],
  prefixes: ['calendar.'],
  ctx: ['calendar'],
  keywords: /\b(calendar|event|schedule a meeting|appointment)\b/i,
  summary: '`calendar.events/get/create/update/delete` — synced Google Calendar',
  migration: 'Direct Google Calendar API calls or app-run event polling → `calendar.*` / `ctx.calendar.*`.',
  visibility: { standalone: false },
  revocable: true,

  buildCtx(app) {
    const name = app.name;
    const C = () => require('../calendar-engine');
    // Platform calendar engine (events come back with resolved colors + `when` labels).
    return {
      calendar: {
        events: (params) => C().listEvents(params || {}, name),
        get: (params) => C().getEvent(params, name),
        create: (params) => C().createEvent(params, { source: 'bridge', appName: name }),
        update: (params) => C().updateEvent(params, { source: 'bridge', appName: name }),
        delete: (params) => C().deleteEvent(params, { source: 'bridge', appName: name }),
        move: (params) => C().moveEvent(params, { source: 'bridge', appName: name }),
        listCalendars: (params) => C().listCalendars(params),
        selectCalendars: (params) => C().selectCalendars(params),
        // The calendar events created without an explicit calendarId land in —
        // shared by the app UI and platform-staged proposals, so both agree.
        defaultCalendarId: (account) => C().defaultCalendarId(account),
        setDefaultCalendar: (params) => C().setDefaultCalendar(params || {}),
        // "Is this slot free?" answered by Google across every calendar the
        // account can see — including ones whose event detail it may not read,
        // which no events-window scan can reach.
        freeBusy: (params) => C().freeBusy(params || {}),
        availability: (params) => C().availability(params || {}),
        colors: (params) => C().colors(params),
        annotate: (params) => C().annotate(params, name),
        annotations: (params) => C().annotations(params, name),
        syncStatus: (params) => C().syncStatus(params || {}),
        syncNow: (params) => C().syncNow(params || {}),
        formatWhen: (iso, tz) => C().formatCalendarWhen(iso, tz),
        // Calendar events share the engine bus (calendar:changed / calendar:annotated).
        on: (event, handler) => require('../email-engine').registerHandler(name, event, handler),
        subscribe: (events) => require('../email-engine').subscribe(name, events),
      },
    };
  },

  bridge: {
    'calendar.events': (app, params) => require('../calendar-engine').listEvents(params, app.name),
    'calendar.get': async (app, params) => {
      if (!params.account || !params.eventId) throw new Error('account and eventId required');
      return require('../calendar-engine').getEvent(params, app.name);
    },
    'calendar.create': async (app, params) => {
      if (!params.account) throw new Error('account required');
      return require('../calendar-engine').createEvent(params, { source: 'bridge', appName: app.name });
    },
    'calendar.update': async (app, params) => {
      if (!params.account || !params.eventId) throw new Error('account and eventId required');
      return require('../calendar-engine').updateEvent(params, { source: 'bridge', appName: app.name });
    },
    'calendar.move': async (app, params) => {
      if (!params.account || !params.eventId || !params.destinationCalendarId) throw new Error('account, eventId and destinationCalendarId required');
      return require('../calendar-engine').moveEvent(params, { source: 'bridge', appName: app.name });
    },
    'calendar.delete': async (app, params) => {
      if (!params.account || !params.eventId) throw new Error('account and eventId required');
      return require('../calendar-engine').deleteEvent(params, { source: 'bridge', appName: app.name });
    },
    'calendar.listCalendars': async (app, params) => {
      if (!params.account) throw new Error('account required');
      return require('../calendar-engine').listCalendars(params);
    },
    'calendar.selectCalendars': async (app, params) => {
      if (!params.account) throw new Error('account required');
      return require('../calendar-engine').selectCalendars(params);
    },
    // The default calendar an event lands in when `calendarId` is omitted.
    // Same pair as ctx.calendar.defaultCalendarId/setDefaultCalendar — note the
    // engine takes a bare account here and an object on the setter.
    'calendar.defaultCalendarId': async (app, params) => {
      if (!params.account) throw new Error('account required');
      return require('../calendar-engine').defaultCalendarId(params.account);
    },
    'calendar.setDefaultCalendar': async (app, params) => {
      if (!params.account) throw new Error('account required');
      return require('../calendar-engine').setDefaultCalendar(params);
    },
    'calendar.freeBusy': (app, params) => require('../calendar-engine').freeBusy(params || {}),
    'calendar.availability': (app, params) => require('../calendar-engine').availability(params || {}),
    'calendar.colors': (app, params) => require('../calendar-engine').colors(params),
    'calendar.annotate': (app, params) => require('../calendar-engine').annotate(params, app.name),
    'calendar.annotations': (app, params) => require('../calendar-engine').annotations(params, app.name),
    'calendar.syncStatus': (app, params) => require('../calendar-engine').syncStatus(params),
    'calendar.syncNow': (app, params) => require('../calendar-engine').syncNow(params),
    'calendar.subscribe': async (app, params) => require('../email-engine').subscribe(app.name, params.events),
  },

  // ---- Horst facet: read-only tools, approval-gated kinds --------------------
  horst: {
    lane: {
      direct: {
        'calendar.events': 'calendar_list', 'calendar.get': 'calendar_list',
        'calendar.listCalendars': 'calendar_calendars', 'calendar.defaultCalendarId': 'calendar_calendars',
        'calendar.freeBusy': 'calendar_freebusy', 'calendar.availability': 'calendar_freebusy',
        'calendar.annotations': { deferred: 'app-written annotations; no chat need yet' },
        'calendar.syncStatus': { deferred: 'sync trouble reaches Horst as a sense' },
      },
      card: {
        'calendar.create': 'calendar.create', 'calendar.update': 'calendar.update',
        'calendar.move': 'calendar.move', 'calendar.delete': 'calendar.delete',
        'calendar.selectCalendars': { missing: 'which calendars sync is the owner\'s setup, in the Calendar settings' },
        'calendar.setDefaultCalendar': { missing: 'the default calendar is the owner\'s setup, in the Calendar settings' },
        'calendar.annotate': { missing: 'annotations are app-written' },
        'calendar.syncNow': { missing: 'sync runs on its own schedule; no remedy kind yet' },
      },
      never: ['calendar.colors', 'calendar.subscribe'],
      why: 'colors are a UI palette; calendar.subscribe is an app\'s live feed',
    },
    brief: 'calendar: list/create/update/move events; guests only through calendar.invite (every change is approval-gated)',
    // Horst could propose calendar writes but could not NOTICE one. A meeting
    // moved on someone else's initiative, a cancellation, a double-booking —
    // all invisible, while `email:new` has been a first-class sense since
    // phase 6. `calendar:changed` was already dispatched from every write path;
    // it just never reached the bus.
    senses: [
      {
        kind: 'calendar:changed',
        description: 'Events changed on a synced calendar — someone moved, added or cancelled a meeting',
        // The owner's diary changing is worth knowing about and almost never
        // worth interrupting for: it belongs on the agenda he reads, not in a
        // notification. A conflict worth acting on is a judgement made when he
        // reads it, not a property of the event.
        defaultPolicy: 'agenda',
      },
    ],
    wire({ publish }) {
      const emailEngine = require('../email-engine');
      // Its own handler name: platform-horst registers a 'horst' handler on the
      // same event to invalidate pending verdicts, and email-embed registers
      // another to kick the embedding sweep. All three coexist (the registry
      // holds a Set per event); a distinct name keeps this one out of reach of
      // any clearHandlers('horst').
      return emailEngine.registerHandler('horst:calendar-sense', 'calendar:changed', (d) => {
        if (!d || !d.account) return;
        // ONLY changes discovered by sync — i.e. made somewhere other than
        // here. A write Horst just made through an approved proposal would
        // otherwise come straight back to him as news, which is both noise and
        // a loop: he would be sensing his own actions.
        if (d.action !== 'sync') return;
        const ids = Array.isArray(d.eventIds) ? d.eventIds : [];
        if (!ids.length) return;
        publish(
          'calendar:changed',
          { account: d.account, calendarId: d.calendarId || null, eventIds: ids.slice(0, 20), count: ids.length },
          {
            // One agenda line per calendar per sync tick, not one per event.
            dedupeKey: `calendar-changed:${d.account}:${d.calendarId || 'all'}`,
            summary: `${ids.length} calendar event${ids.length === 1 ? '' : 's'} changed on ${d.account}`.slice(0, 120),
          },
        );
      });
    },
    tools: [
      {
        def: {
          name: 'calendar_list',
          description: 'List the user\'s calendar events in a time window. Returns title, when, end, location, attendee emails, account, eventId, calendarId. Read-only — event changes go through governance proposals.',
          inputSchema: { type: 'object', properties: {
            timeMin: { type: 'string', description: 'ISO start (default: now).' },
            timeMax: { type: 'string', description: 'ISO end (default: +14 days).' },
            limit: { type: 'number', description: 'Max events (default 30, max 100).' },
          } },
        },
        handler: async (args) => {
          const calendarEngine = require('../calendar-engine');
          const { textResult } = require('../horst-facet');
          const now = new Date();
          const timeMin = args.timeMin || now.toISOString();
          const timeMax = args.timeMax || new Date(now.getTime() + 14 * 24 * 3600e3).toISOString();
          const r = await calendarEngine.listEvents({
            timeMin, timeMax, limit: Math.min(Math.max(Number(args.limit) || 30, 1), 100),
          }, 'horst');
          const rows = (r?.events || r || []).map((e) => ({
            title: e.title || e.summary || '(untitled)', when: e.when || e.start_datetime || e.start?.dateTime || e.start?.date,
            end: e.end?.dateTime || e.end?.date || undefined, location: e.location || undefined,
            attendees: guestList(e.attendees).length ? guestList(e.attendees) : undefined,
            account: e.account || e._account, eventId: e.id || e.event_id, calendarId: e._calendarId || undefined,
          }));
          return textResult(rows.length ? rows : 'No events in that window.');
        },
      },
      {
        def: {
          name: 'calendar_calendars',
          description: 'List the user\'s calendars themselves (not their events): id, name, account, whether it is selected for sync and which one is the default destination for new events. Use this to name a calendarId on a create/move proposal. Read-only.',
          inputSchema: { type: 'object', properties: {
            account: { type: 'string', description: 'One Google account (email). Default: all connected calendar accounts.' },
          } },
        },
        handler: async (args) => {
          const calendarEngine = require('../calendar-engine');
          const { textResult } = require('../horst-facet');
          const accounts = args.account ? [args.account] : calendarEngine.calendarAccounts();
          if (!accounts.length) return textResult('No Google account has calendar access.');
          const rows = [];
          for (const account of accounts) {
            // One unreachable account must not blank the others — an expired
            // token on a second account is a fact worth reporting, not a failure.
            try {
              for (const cal of await calendarEngine.listCalendars({ account })) {
                rows.push({
                  account, calendarId: cal.id, name: cal.summary || cal.name || cal.id,
                  selected: !!cal.selected, isDefault: cal.isDefault || undefined,
                  accessRole: cal.accessRole || undefined, timeZone: cal.timeZone || undefined,
                });
              }
            } catch (err) { rows.push({ account, error: err.message }); }
          }
          return textResult(rows.length ? rows : 'No calendars.');
        },
      },
      {
        def: {
          name: 'calendar_freebusy',
          description: 'Ask when the user is free or busy in a window, across every calendar the account can see — including ones whose event details are not readable, which listing events cannot cover. Returns merged busy intervals and, when minMinutes is given, the free slots of at least that length. Use this before proposing a meeting time rather than reasoning over calendar_list output. Read-only.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Google account (email). Default: the first calendar-enabled account.' },
              timeMin: { type: 'string', description: 'Window start, ISO 8601.' },
              timeMax: { type: 'string', description: 'Window end, ISO 8601. Max 90 days after timeMin.' },
              minMinutes: { type: 'number', description: 'If given, also return free slots at least this many minutes long.' },
            },
            required: ['timeMin', 'timeMax'],
          },
        },
        handler: async (args) => {
          const calendarEngine = require('../calendar-engine');
          const { textResult } = require('../horst-facet');
          const account = calendarAccountOrThrow(args || {});
          const params = { account, timeMin: args.timeMin, timeMax: args.timeMax };
          const res = args.minMinutes
            ? await calendarEngine.availability({ ...params, minMinutes: args.minMinutes })
            : await calendarEngine.freeBusy(params);
          // A calendar that could not be read is reported, never silently
          // treated as free — a false "free" is the one wrong answer here.
          return textResult({
            account: res.account,
            window: { from: res.timeMin, to: res.timeMax },
            busy: res.busy,
            free: res.free,
            unreadable: res.errors,
          });
        },
      },
    ],
    kinds: {
      'calendar.create': {
        appProposable: true, // apps may stage it (docs/governance.md, appMayStage)
        label: 'Create calendar event',
        about: 'Creates an event in your Google Calendar — typically one Horst spotted in an email or attachment.',
        ceiling: 'auto',
        defaultLevel: 'propose',
        notify: 'none', // event cards are reviewed in the Approvals views, not pushed
        validate(p) {
          calendarAccountOrThrow(p);
          refuseGuests(p, 'calendar.create');
          if (!String(p.title || p.summary || '').trim()) throw new Error('payload requires title');
          if (!p.date && !p.start) throw new Error('payload requires date or start');
        },
        describe: (p) => `Create event "${p.title || p.summary || '(untitled)'}"${p.date ? ` on ${p.date}` : ''}`,
        // One appointment = one identity, whichever email mentioned it. The
        // account is resolved the SAME way the executor resolves it, or the
        // defaulted and the explicit form of one act would get two keys.
        identity(p) {
          const ident = require('../governance/horst-identity');
          let account;
          try { account = calendarAccountOrThrow(p); } catch { account = p.account; }
          return ident.calendarKey({
            account,
            title: p.title || p.summary,
            date: p.date || p.start?.date || p.start?.dateTime,
            startTime: p.startTime || p.start?.dateTime,
          });
        },
        execute: (p, proposal) => require('../calendar-engine').createEvent(
          { ...p, account: calendarAccountOrThrow(p) },
          { source: 'bridge', appName: proposal?.app || 'horst' },
        ).then((ev) => ({ ok: true, summary: `Event created${ev?.id ? ` (${ev.id})` : ''}`, eventId: ev?.id })),
      },

      'calendar.update': {
        appProposable: true, // apps may stage it (docs/governance.md, appMayStage)
        label: 'Update calendar event',
        about: 'Edits an existing event: time, title, location, description. Guests are left alone and not notified (inviting is calendar.invite).',
        ceiling: 'auto',
        defaultLevel: 'propose',
        notify: 'none',
        validate(p) { const { req } = require('../horst-facet'); calendarAccountOrThrow(p); req(p, 'eventId'); refuseGuests(p, 'calendar.update'); },
        describe: (p) => `Update event ${p.eventId}${p.title ? ` → "${p.title}"` : ''}`,
        // Keyed to the event being edited, NOT to the create namespace: a
        // genuine "move this meeting" must not be mistaken for the already
        // executed create of the same appointment. A create that was CONVERTED
        // into an update keeps the create's key instead — governance carries
        // intentKey through conversion untouched, which is what makes the
        // converted twin findable.
        identity: (p) => require('../governance/horst-identity').objectKey('calupd', { account: p.account, id: p.eventId }),
        execute: (p, proposal) => require('../calendar-engine').updateEvent(
          { ...p, account: calendarAccountOrThrow(p) },
          { source: 'bridge', appName: proposal?.app || 'horst' },
        ).then((ev) => ({ ok: true, summary: 'Event updated', eventId: ev?.id })),
      },

      'calendar.move': {
        label: 'Move event to another calendar',
        about: 'Moves an event to another of your calendars on the same account (Meet links survive). Guests are not notified.',
        ceiling: 'auto',
        defaultLevel: 'propose',
        undo: true, // the executor records the calendar it left; undo moves it back
        validate(p) {
          const { req } = require('../horst-facet');
          calendarAccountOrThrow(p);
          req(p, 'eventId');
          req(p, 'destinationCalendarId');
          if ((p.calendarId || 'primary') === p.destinationCalendarId) throw new Error('the event is already in that calendar');
        },
        describe: (p) => `Move event ${p.eventId}${p.title ? ` ("${p.title}")` : ''} to ${p.destinationCalendarName || p.destinationCalendarId}`,
        identity: (p) => require('../governance/horst-identity').objectKey('calmove', { account: p.account, id: `${p.eventId}>${p.destinationCalendarId}` }),
        card: (p) => ({
          icon: '📅',
          title: p.title ? `Move "${p.title}"` : `Move event ${p.eventId}`,
          subtitle: p.account || null,
          fields: [
            { label: 'From', kind: 'text', value: p.calendarName || p.calendarId || 'primary' },
            { label: 'To', kind: 'text', value: p.destinationCalendarName || p.destinationCalendarId },
          ],
          footer: `event ${p.eventId}`,
        }),
        execute: async (p, proposal) => {
          const engine = require('../calendar-engine');
          const account = calendarAccountOrThrow(p);
          // The calendar it is in now: named, else the mirror's, else Google's primary.
          const from = p.calendarId || (await engine.getEvent({ account, eventId: p.eventId }, 'horst').catch(() => null))?._calendarId || 'primary';
          const ev = await engine.moveEvent(
            { account, eventId: p.eventId, calendarId: from, destinationCalendarId: p.destinationCalendarId, sendUpdates: 'none' },
            { source: 'bridge', appName: proposal?.app || 'horst' },
          );
          return {
            ok: true, summary: `Event moved to ${p.destinationCalendarName || p.destinationCalendarId}`, eventId: ev?.id,
            inverse: {
              kind: 'calendar.move',
              payload: { account, eventId: ev?.id || p.eventId, calendarId: p.destinationCalendarId, destinationCalendarId: from, ...(p.title ? { title: p.title } : {}) },
              summary: `Undo: move event back to ${p.calendarName || from}`,
            },
          };
        },
      },

      'calendar.invite': {
        label: 'Invite guests to an event',
        about: 'Creates an event with guests, or adds guests to an existing one. Google emails every guest the invitation.',
        pinNote: 'An invitation is mail to third parties, sent by Google in your name — outward-facing, so it always needs a human (G9).',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          calendarAccountOrThrow(p);
          if (!Array.isArray(p.attendees) || !p.attendees.length) throw new Error('payload requires attendees (email addresses)');
          const bad = guestList(p.attendees).find((a) => !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(a));
          if (bad || guestList(p.attendees).length !== p.attendees.length) throw new Error(`not an email address: "${bad || p.attendees.find((a) => !guestList([a]).length)}"`);
          if (p.eventId != null) { req(p, 'eventId'); return; }
          if (!String(p.title || p.summary || '').trim()) throw new Error('payload requires title (or eventId to invite to an existing event)');
          if (!p.date && !p.start) throw new Error('payload requires date or start');
        },
        describe: (p) => `Invite ${guestList(p.attendees).join(', ')} to ${p.eventId ? `event ${p.eventId}` : `"${p.title || p.summary}"${p.date ? ` on ${p.date}` : ''}`}`,
        // The guest list IS the decision, so the card leads with it (the generic
        // calendar card has no guests row).
        card: (p) => ({
          icon: '📅',
          title: p.eventId ? `Invite guests${p.title ? ` to "${p.title}"` : ''}` : `New event with guests: "${p.title || p.summary}"`,
          subtitle: p.account || null,
          fields: [
            { label: 'Guests', kind: 'text', value: guestList(p.attendees).join(', ') },
            ...(p.date || p.startTime ? [{ label: 'When', kind: 'text', value: [p.date, p.startTime && `${p.startTime}${p.endTime ? `–${p.endTime}` : ''}`].filter(Boolean).join(' ') }] : []),
            ...(p.location ? [{ label: 'Where', kind: 'text', value: p.location }] : []),
          ],
          warn: 'Google emails each guest the invitation in your name.',
          footer: p.eventId ? `event ${p.eventId}` : null,
        }),
        // The event plus the guest set: inviting the same people to the same
        // event twice is one act.
        identity(p) {
          const ident = require('../governance/horst-identity');
          const target = p.eventId || [ident.normText(p.title || p.summary), p.date || p.start?.dateTime || p.start?.date, p.startTime || ''].join('|');
          return ident.objectKey('calinv', { account: p.account, id: `${target}:${[...new Set(guestList(p.attendees))].sort().join(',')}` });
        },
        async execute(p, proposal) {
          const engine = require('../calendar-engine');
          const account = calendarAccountOrThrow(p);
          const origin = { source: 'bridge', appName: proposal?.app || 'horst' };
          if (!p.eventId) {
            const ev = await engine.createEvent({ ...p, account, attendees: guestList(p.attendees) }, origin);
            return { ok: true, summary: `Event created and ${p.attendees.length} guest(s) invited${ev?.id ? ` (${ev.id})` : ''}`, eventId: ev?.id };
          }
          // Guests are ADDED: a PATCH replaces the attendee list, so the
          // current guests are carried — an invite must never uninvite anyone.
          const current = await engine.getEvent({ account, eventId: p.eventId }, 'horst').catch(() => null);
          const guests = [...new Set([...guestList(current?.attendees), ...guestList(p.attendees)])];
          const ev = await engine.updateEvent({ ...p, account, calendarId: p.calendarId || current?._calendarId || undefined, attendees: guests }, origin);
          return { ok: true, summary: `${guestList(p.attendees).length} guest(s) invited`, eventId: ev?.id };
        },
      },

      'calendar.delete': {
        appProposable: true, // apps may stage it (docs/governance.md, appMayStage)
        label: 'Delete calendar event',
        about: 'Removes an event from your calendar.',
        pinNote: 'Destructive and not cleanly undoable — always confirmed by a human.',
        ceiling: 'propose', // destructive — always human-confirmed
        defaultLevel: 'propose',
        validate(p) { const { req } = require('../horst-facet'); calendarAccountOrThrow(p); req(p, 'eventId'); },
        describe: (p) => `Delete event ${p.eventId}${p.title ? ` ("${p.title}")` : ''}`,
        // Its own namespace: creating and deleting an event are opposite acts,
        // and a shared key would let a denied create suppress a later delete.
        identity: (p) => require('../governance/horst-identity').objectKey('caldel', { account: p.account, id: p.eventId }),
        execute: (p, proposal) => require('../calendar-engine').deleteEvent(
          { ...p, account: calendarAccountOrThrow(p) },
          { source: 'bridge', appName: proposal?.app || 'horst' },
        ).then(() => ({ ok: true, summary: 'Event deleted' })),
      },
    },
  },
};
