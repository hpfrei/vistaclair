/* Vista approvals Mini App — the surface where decisions are made.

   Chat is now only a notification, so this page has to stand alone: it renders
   the real card for every kind (via the shared descriptor renderer), puts the
   "you already did this" warning above the buttons, shows what an edit changed,
   and can produce the email a proposal was derived from.

   Stateless by construction. Telegram kills backgrounded webviews, so there is
   no client state worth preserving: every render comes from a poll, and the
   only thing held between polls is which proposal is open. */
(function () {
  'use strict';

  var POLL_MS = 5000;
  var STALE_MS = 48 * 60 * 60 * 1000;

  var PC = window.ProposalCards;
  var esc = PC.escHtml;

  var el = function (id) { return document.getElementById(id); };
  var queueEl = el('queue');
  var detailEl = el('detail');
  var statusPill = el('status-pill');
  var titleEl = el('title');
  var tabsEl = el('tabs');

  var app = window.VcMiniApp.create({
    base: 'api',
    // Both names are app-specific on purpose: sessionStorage and request
    // headers are global to the origin, and the CLI session Mini App also
    // lives under /pro/*. See src/apps/tg-miniapp-auth.js.
    storageKey: 'vcVistaToken',
    header: 'X-Vista-Session',
    onStatus: setStatus,
  });
  var tg = app.tg;

  var tab = 'approvals';
  var openId = null;       // the proposal shown in the detail pane
  var editing = false;     // suppresses re-render so a poll cannot eat typing
  var busy = {};           // id → true, so a double-tap cannot double-decide
  var lastList = [];       // what the client just saw; bulk is bounded to this
  var sourceCache = {};    // proposal id → the source-mail response
  var dayCache = {};       // 'YYYY-MM-DD' → that day's events, for conflicts
  var mail = { account: null, folder: null, list: [], total: 0, loaded: false, openUid: null, detail: null, ready: true };
  var cal = { date: null, data: null };
  var brief = { data: null, loaded: false };
  // openId/detail are the file shown in the detail pane. While it is set the
  // poll leaves the list alone: re-rendering would stop a playing <video>.
  var files = { kind: null, list: [], counts: {}, loaded: false, error: null, sig: null, openId: null, detail: null, busy: false };

  // A date-only string is parsed by JS as UTC midnight, so re-deriving its
  // weekday in local time shifts it a day in any negative-offset zone. Format
  // date-only values in UTC — exactly what calendar-engine's formatCalendarWhen
  // does — and only ever format real instants (timed events) locally.
  function formatDayLabel(dateStr) {
    var d = new Date(dateStr + 'T00:00:00Z');
    if (isNaN(d)) return dateStr;
    try {
      return new Intl.DateTimeFormat(undefined, {
        weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
      }).format(d);
    } catch (e) { return dateStr; }
  }

  function todayLocal() {
    var n = new Date();
    return n.getFullYear() + '-'
      + String(n.getMonth() + 1).padStart(2, '0') + '-'
      + String(n.getDate()).padStart(2, '0');
  }

  function shiftDay(dateStr, days) {
    var d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function clockOf(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  var TAB_TITLES = { approvals: '📥 Approvals', briefing: '📰 Briefing', mail: '✉ Mail', calendar: '📅 Calendar', files: '📁 Files' };

  function setStatus(cls, text) {
    statusPill.className = 'pill ' + cls;
    statusPill.textContent = text;
  }

  function ageLabel(ms) {
    var mins = Math.floor(ms / 60000);
    if (mins < 60) return mins + 'm';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h';
    return Math.floor(hrs / 24) + 'd';
  }

  function ageOf(p) { return Date.now() - (p.createdAt || Date.now()); }
  function isStale(p) { return ageOf(p) > STALE_MS; }
  function byId(id) {
    for (var i = 0; i < lastList.length; i++) if (lastList[i].id === id) return lastList[i];
    return null;
  }

  // --- shared card fragments ---------------------------------------------------

  function priorBlock(p) {
    if (!p.prior || p.prior.state === 'none') return '';
    var icon = p.prior.state === 'partial' ? '🔁' : '✅';
    return '<div class="prop-prior">' + icon + ' ' + esc(p.prior.label)
      + (p.prior.detail ? ' — ' + esc(p.prior.detail) : '') + '</div>';
  }

  function notesBlock(p) {
    if (!p.brainNotes || !p.brainNotes.notes) return '';
    return p.brainNotes.notes.slice(0, 2).map(function (n) {
      return '<div class="prop-note">🧠 ' + esc(n) + '</div>';
    }).join('');
  }

  // Provenance with zero reads — it survives deletion of the mail itself.
  function sourceBanner(p) {
    var s = p.source;
    if (!s || s.type !== 'email') return '';
    var when = s.date ? new Date(s.date) : null;
    var bits = [];
    if (s.from) bits.push(s.from);
    if (when && !isNaN(when)) bits.push(when.toLocaleDateString([], { day: 'numeric', month: 'short' }));
    var what = s.subject ? '"' + esc(s.subject) + '"' : 'message #' + esc(String(s.uid == null ? '?' : s.uid));
    return '<div class="prop-source">↩ From the email ' + what + (bits.length ? ' — ' + esc(bits.join(', ')) : '') + '</div>';
  }

  // Draft → what you are about to approve. originalPayload has been on the wire
  // since payload editing existed; an edited card gave no sign of what changed.
  function diffBlock(p) {
    if (!p.editedAt || !p.originalPayload) return '';
    var before = p.originalPayload || {};
    var after = p.payload || {};
    var show = function (v) {
      if (v == null || v === '') return '(empty)';
      var s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > 160 ? s.slice(0, 160) + '…' : s;
    };
    var keys = Object.keys(before).concat(Object.keys(after)).filter(function (k, i, a) { return a.indexOf(k) === i; });
    var rows = keys.filter(function (k) {
      return JSON.stringify(before[k]) !== JSON.stringify(after[k]);
    }).slice(0, 8).map(function (k) {
      return '<div class="pd-row"><span class="pd-key">' + esc(k) + '</span>'
        + '<span class="pd-before">' + esc(show(before[k])) + '</span>'
        + '<span class="pd-after">' + esc(show(after[k])) + '</span></div>';
    });
    if (!rows.length) return '';
    return '<div class="prop-diff"><b>✎ Edited — you are approving the lower version</b>' + rows.join('') + '</div>';
  }

  // --- list --------------------------------------------------------------------

  function propRow(p) {
    return '<div class="prop tappable' + (isStale(p) ? ' stale' : '') + '" data-id="' + esc(p.id) + '">'
      + '<div class="prop-top"><span class="prop-kind">' + esc(p.kind) + (p.app ? ' · ' + esc(p.app) : '')
      + '</span><span class="prop-age">' + esc(ageLabel(ageOf(p))) + '</span></div>'
      + priorBlock(p)
      + PC.renderDescriptorCard(p.card)
      + '</div>';
  }

  function groupBlock(label, list, bulk) {
    if (!list.length) return '';
    var head = '<div class="group-head"><span>' + esc(label) + ' · ' + list.length + '</span>'
      + (bulk
        ? '<span class="bulk">'
          + '<button data-bulk="extend">Keep 7 days</button>'
          + '<button data-bulk="withdraw">Withdraw all</button>'
          + '<button data-bulk="deny" class="danger">Deny all</button>'
          + '</span>'
        : '')
      + '</div>';
    return head + list.map(propRow).join('');
  }

  // --- mail (read-only) --------------------------------------------------------

  function mailRow(m) {
    var when = m.date ? new Date(m.date) : null;
    var atts = (m.attachments || []).length;
    return '<div class="mrow' + (m.isUnread ? ' unread' : '') + '" data-mail="' + esc(String(m.id)) + '">'
      + '<div class="mrow-top"><span class="mrow-from">' + esc(m.from || '(unknown)') + '</span>'
      + '<span class="mrow-date">' + esc(when && !isNaN(when) ? when.toLocaleDateString([], { day: 'numeric', month: 'short' }) : '') + '</span></div>'
      + '<div class="mrow-subj">' + esc(m.subject || '(no subject)') + '</div>'
      + '<div class="mrow-snip">' + esc(m.snippet || '') + '</div>'
      + (atts ? '<span class="att-chip">📎 ' + atts + '</span>' : '')
      + '</div>';
  }

  function renderMail() {
    if (!mail.ready) {
      queueEl.innerHTML = '<div class="empty">The mail engine is not running.</div>';
      return;
    }
    if (!mail.loaded) { queueEl.innerHTML = '<div class="empty">Loading…</div>'; return; }
    var head = '<div class="group-head"><span>' + esc(mail.account || 'All accounts')
      + (mail.total ? ' · ' + mail.total : '') + '</span></div>';
    queueEl.innerHTML = head + (mail.list.length
      ? mail.list.map(mailRow).join('')
      : '<div class="empty">No mail here.</div>');
  }

  async function loadMail() {
    try {
      var q = 'mail?limit=50' + (mail.account ? '&account=' + encodeURIComponent(mail.account) : '');
      var r = await app.api(q);
      mail.ready = r.ready !== false;
      mail.list = r.emails || [];
      mail.total = r.total || 0;
      mail.loaded = true;
      if (tab === 'mail' && !mail.openUid) renderMail();
    } catch (e) { setStatus('error', e.message); }
  }

  async function openMail(uid) {
    var m = null;
    for (var i = 0; i < mail.list.length; i++) if (String(mail.list[i].id) === String(uid)) m = mail.list[i];
    if (!m) return;
    mail.openUid = uid;
    queueEl.hidden = true;
    detailEl.hidden = false;
    detailEl.innerHTML = '<div class="prop"><div class="tl-note">Loading…</div></div>';
    syncChrome();
    try {
      var r = await app.api('mail/' + encodeURIComponent(m.account) + '/' + encodeURIComponent(uid));
      if (mail.openUid !== uid) return;
      detailEl.innerHTML = '<div class="prop">' + renderSourceMail(r.missing ? r : { email: r.email }, 'Message') + '</div>';
    } catch (e) {
      detailEl.innerHTML = '<div class="prop"><div class="tl-note">' + esc(e.message) + '</div></div>';
    }
  }

  // --- calendar (read-only) ----------------------------------------------------

  function eventRow(e) {
    var time = e.allDay ? 'All day' : clockOf(e.start) + '–' + clockOf(e.end);
    return '<div class="erow"><span class="erow-time">' + esc(time) + '</span>'
      + '<span class="erow-body"><span class="erow-title">' + esc(e.summary) + '</span>'
      + (e.location ? '<span class="erow-loc">' + esc(e.location) + '</span>' : '') + '</span></div>';
  }

  function renderCalendar() {
    var d = cal.date || todayLocal();
    var nav = '<div class="daynav">'
      + '<button data-day="-1">‹</button>'
      + '<span>' + esc(formatDayLabel(d)) + '</span>'
      + '<button data-day="1">›</button></div>';
    if (!cal.data) { queueEl.innerHTML = nav + '<div class="empty">Loading…</div>'; return; }
    var evs = cal.data.events || [];
    queueEl.innerHTML = nav + (evs.length
      ? evs.map(eventRow).join('')
      : '<div class="empty">Nothing on this day.</div>');
  }

  async function loadCalendar() {
    var d = cal.date || todayLocal();
    cal.date = d;
    try {
      var r = await app.api('calendar/day?date=' + encodeURIComponent(d));
      cal.data = r;
      dayCache[d] = r;
      if (tab === 'calendar') renderCalendar();
    } catch (e) { setStatus('error', e.message); }
  }

  // --- briefing (read-only) ----------------------------------------------------
  //
  // Horst composes one each morning and journals it; nothing pushes it to the
  // chat. The title already carries its date, so the header only adds how old
  // it is — the one thing the text itself cannot say.

  function renderBriefing() {
    if (!brief.loaded) { queueEl.innerHTML = '<div class="empty">Loading…</div>'; return; }
    var b = brief.data;
    if (!b || !b.text) {
      queueEl.innerHTML = '<div class="empty">No briefing yet — Horst composes one each morning.</div>';
      return;
    }
    var head = '<div class="group-head"><span>' + esc(b.title || 'Briefing') + '</span>'
      + '<span>' + esc(b.at ? ageLabel(Date.now() - b.at) + ' ago' : '') + '</span></div>';
    // Same line renderer the mail bodies use, so quoted lines and separators
    // read identically wherever plain text is shown on this surface.
    queueEl.innerHTML = head + '<div class="brief-body">' + PC.renderBody(b.text) + '</div>';
  }

  async function loadBriefing() {
    try {
      var r = await app.api('briefing');
      brief.data = r.briefing || null;
      brief.loaded = true;
      if (tab === 'briefing') renderBriefing();
    } catch (e) { setStatus('error', e.message); }
  }

  // --- files (what Horst and the apps delivered) -------------------------------
  //
  // rec.src is a ticketed byte URL that needs no headers, so it goes straight
  // into <img>/<audio>/<video>. Tickets expire: every use takes the src from
  // the newest fetch, never a cached one.

  var FILE_KINDS = [
    ['', 'All'], ['picture', 'Pictures'], ['audio', 'Audio'],
    ['video', 'Video'], ['model', '3D models'], ['document', 'Documents'],
  ];
  var FILE_ICONS = { picture: '🖼', audio: '🎵', video: '🎬', model: '🧊', document: '📄' };

  function isFileKind(k) {
    for (var i = 1; i < FILE_KINDS.length; i++) if (FILE_KINDS[i][0] === k) return true;
    return false;
  }

  function fileTitle(f) { return f.title || f.name || 'file'; }

  function fileSource(f) {
    if (f.app && f.tool) return f.app + ' › ' + f.tool;
    return f.app || f.tool || f.source || '';
  }

  function humanSize(n) {
    n = Number(n);
    if (!isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' kB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  }

  function fileDate(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return '';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + clockOf(iso);
  }

  function withParam(src, param) {
    return src + (src.indexOf('?') >= 0 ? '&' : '?') + param;
  }

  function absUrl(rel) { return new URL(rel, location.href).href; }

  function fileChips() {
    var c = files.counts || {};
    var total = 0;
    for (var i = 1; i < FILE_KINDS.length; i++) total += Number(c[FILE_KINDS[i][0]]) || 0;
    return '<div class="fchips" data-files-root>' + FILE_KINDS.map(function (k) {
      var n = k[0] ? (Number(c[k[0]]) || 0) : total;
      var active = (files.kind || '') === k[0];
      var empty = files.loaded && !n && !active;
      return '<button class="fchip' + (active ? ' active' : '') + (empty ? ' dim' : '') + '"'
        + (empty ? ' disabled' : '') + ' data-fkind="' + esc(k[0]) + '">'
        + esc(k[1]) + (files.loaded ? ' · ' + n : '') + '</button>';
    }).join('') + '</div>';
  }

  function fileThumb(f) {
    if (f.kind === 'picture' && f.src && !f.missing) {
      return '<span class="frow-thumb"><img loading="lazy" alt="" src="' + esc(f.src) + '"></span>';
    }
    return '<span class="frow-thumb icon">' + (FILE_ICONS[f.kind] || '📄') + '</span>';
  }

  function fileRow(f) {
    var title = fileTitle(f);
    var meta = [fileDate(f.at), humanSize(f.size)].filter(Boolean).join(' · ');
    return '<div class="frow' + (f.missing ? ' missing' : '') + '" data-file="' + esc(f.id) + '">'
      + fileThumb(f)
      + '<span class="frow-body">'
      + '<span class="frow-title">' + esc(title) + '</span>'
      + (f.name && f.name !== title ? '<span class="frow-name">' + esc(f.name) + '</span>' : '')
      + '<span class="frow-meta"><span class="frow-src">' + esc(fileSource(f)) + '</span>'
      + '<span class="frow-when">' + esc(meta) + '</span></span>'
      + (f.missing ? '<span class="frow-gone">This file is no longer available.</span>' : '')
      + '</span></div>';
  }

  function renderFiles() {
    if (!files.loaded) {
      files.sig = null;
      queueEl.innerHTML = fileChips() + '<div class="empty">'
        + esc(files.error ? 'Files could not be loaded: ' + files.error : 'Loading…') + '</div>';
      return;
    }
    // The poll refetches every tick; rewriting identical rows would reload
    // every thumbnail under its fresh ticket, so skip a no-op render.
    var sig = (files.kind || '') + '|' + JSON.stringify(files.counts || {}) + '|'
      + files.list.map(function (f) { return f.id + (f.missing ? '!' : ''); }).join(',');
    if (sig === files.sig && queueEl.querySelector('[data-files-root]')) return;
    files.sig = sig;
    var label = '';
    for (var i = 0; i < FILE_KINDS.length; i++) if (FILE_KINDS[i][0] === (files.kind || '')) label = FILE_KINDS[i][1];
    queueEl.innerHTML = fileChips() + (files.list.length
      ? files.list.map(fileRow).join('')
      : '<div class="empty">' + esc(files.kind
        ? 'No ' + label.toLowerCase() + ' yet.'
        : 'No files yet — whatever Horst or an app delivers to you lands here.') + '</div>');
  }

  async function loadFiles() {
    var kind = files.kind;
    try {
      var r = await app.api('files' + (kind ? '?kind=' + encodeURIComponent(kind) : ''));
      if (kind !== files.kind) return; // the filter changed while this was in flight
      files.list = r.files || [];
      files.counts = r.counts || {};
      files.loaded = true;
      files.error = null;
      if (tab === 'files' && !files.openId) renderFiles();
    } catch (e) {
      files.error = e.message;
      if (tab === 'files' && !files.openId && !files.loaded) renderFiles();
      setStatus('error', e.message);
    }
  }

  function setFileKind(kind) {
    files.kind = kind || null;
    files.loaded = false;
    files.list = [];
    renderFiles();
    loadFiles();
  }

  // The file in the detail pane or one of its delivery siblings.
  function detailRec(id) {
    var d = files.detail;
    if (!d) return null;
    if (d.file && d.file.id === id) return d.file;
    var b = d.batch || [];
    for (var i = 0; i < b.length; i++) if (b[i].id === id) return b[i];
    return null;
  }

  function fileMedia(f) {
    if (f.missing || !f.src) return '<div class="tl-note">This file is no longer available.</div>';
    if (f.kind === 'picture') {
      return '<img class="file-full" alt="' + esc(fileTitle(f)) + '" src="' + esc(f.src) + '" data-file-full="' + esc(f.id) + '">';
    }
    if (f.kind === 'audio') return '<audio class="file-media" controls preload="metadata" src="' + esc(f.src) + '"></audio>';
    if (f.kind === 'video') return '<video class="file-media" controls playsinline preload="metadata" src="' + esc(f.src) + '"></video>';
    if (f.kind === 'model') {
      var pics = (f.previews || []).map(detailRec).filter(function (p) { return p && !p.missing && p.src; });
      return '<div class="tl-note">🧊 3D model — download it to open in a viewer.</div>'
        + (pics.length
          ? pics.map(function (p) {
            return '<img class="file-full" alt="' + esc(fileTitle(p)) + '" src="' + esc(p.src) + '" data-file-full="' + esc(p.id) + '">';
          }).join('')
          : '<div class="tl-note">No preview pictures came with it.</div>');
    }
    return '';
  }

  function fileFacts(f) {
    var row = function (label, val) {
      return val ? '<div class="mail-row"><span class="mail-label">' + label + '</span><span class="mail-val">' + esc(val) + '</span></div>' : '';
    };
    return '<div class="mail-card">'
      + row('Name', f.name) + row('Type', f.mime) + row('Size', humanSize(f.size))
      + row('From', fileSource(f)) + row('Date', fileDate(f.at))
      + '</div>';
  }

  function batchBlock(f, batch) {
    if (batch.length < 2) return '';
    return '<div class="po-source"><div class="po-source-head">' + batch.length + ' files in this delivery</div><div>'
      + batch.map(function (b) {
        return '<button class="sib-chip' + (b.id === f.id ? ' active' : '') + '" data-file-sib="' + esc(b.id) + '">'
          + (FILE_ICONS[b.kind] || '📄') + ' ' + esc(b.name || fileTitle(b)) + '</button>';
      }).join('')
      + '</div></div>';
  }

  function renderFileDetail() {
    var d = files.detail;
    var f = d && d.file;
    if (!f) return;
    var batch = (d.batch && d.batch.length) ? d.batch : [f];
    var dl = (f.src && !f.missing)
      ? '<a class="file-btn" data-file-download="' + esc(f.id) + '" href="' + esc(absUrl(withParam(f.src, 'download=1')))
        + '" download="' + esc(f.name || 'file') + '">⬇ Download</a>'
      : '';
    detailEl.innerHTML = '<div class="prop">'
      + '<div class="prop-top"><span class="prop-kind"><button class="link-back" data-file-back>‹ Files</button> '
      + esc((FILE_ICONS[f.kind] || '📄') + ' ' + (f.kind || 'file')) + '</span>'
      + '<span class="prop-age">' + esc(fileDate(f.at)) + '</span></div>'
      + '<div class="mail-subject">' + esc(fileTitle(f)) + '</div>'
      + '<div class="file-body">' + fileMedia(f) + '</div>'
      + (f.kind === 'document' || f.kind === 'model' || f.missing ? fileFacts(f)
        : '<div class="tl-note">' + esc([f.name, humanSize(f.size), fileSource(f)].filter(Boolean).join(' · ')) + '</div>')
      + '<div class="prop-actions">' + dl
      + '<button class="deny" data-file-remove="' + esc(f.id) + '">🗑 Remove</button></div>'
      + batchBlock(f, batch)
      + '</div>';
    syncChrome();
  }

  // listOnFail: a deep link that does not resolve falls back to the list
  // instead of stranding the owner on an error pane.
  async function openFile(id, listOnFail) {
    files.openId = id;
    files.detail = null;
    queueEl.hidden = true;
    detailEl.hidden = false;
    detailEl.innerHTML = '<div class="prop"><div class="tl-note">Loading…</div></div>';
    syncChrome();
    try {
      var r = await app.api('files/' + encodeURIComponent(id));
      if (files.openId !== id) return;
      files.detail = { file: r.file, batch: r.batch || [] };
      if (!r.file) throw new Error('That file is no longer available.');
      renderFileDetail();
    } catch (e) {
      if (files.openId !== id) return;
      if (listOnFail) {
        setStatus('error', e.message);
        closeDetail();
        loadFiles();
        return;
      }
      detailEl.innerHTML = '<div class="prop"><button class="link-back" data-file-back>‹ Files</button>'
        + '<div class="tl-note">' + esc(e.message) + '</div></div>';
    }
  }

  // A sibling is already in hand with a ticket from the same fetch.
  function showSibling(id) {
    var sib = detailRec(id);
    if (!sib || sib.id === files.openId) return;
    files.openId = id;
    files.detail = { file: sib, batch: files.detail.batch };
    renderFileDetail();
    el('main').scrollTop = 0;
  }

  // Bot API 8.0 hands the download to Telegram itself; a webview <a download>
  // is the fallback, window.open the last resort when even that is missing.
  function downloadFile(ev, id) {
    var f = detailRec(id);
    if (!f || !f.src) { ev.preventDefault(); return; }
    var url = absUrl(withParam(f.src, 'download=1'));
    if (tg && typeof tg.downloadFile === 'function' && (!tg.isVersionAtLeast || tg.isVersionAtLeast('8.0'))) {
      try {
        tg.downloadFile({ url: url, file_name: f.name || 'file' });
        ev.preventDefault();
        return;
      } catch (e) { /* fall through to the anchor */ }
    }
    if (!('download' in document.createElement('a'))) {
      ev.preventDefault();
      window.open(url, '_blank');
    }
  }

  function openFull(id) {
    var f = detailRec(id);
    if (!f || !f.src) return;
    var url = absUrl(f.src);
    try { if (tg && tg.openLink) { tg.openLink(url); return; } } catch (e) { /* older clients */ }
    window.open(url, '_blank');
  }

  function confirmThen(text, fn) {
    if (tg && typeof tg.showConfirm === 'function') {
      try { tg.showConfirm(text, function (ok) { if (ok) fn(); }); return; } catch (e) { /* below 6.2 */ }
    }
    pageConfirm(text, function (ok) { if (ok) fn(); });
  }

  // Outside Telegram (or on a client without showConfirm) the question is an
  // in-page sheet, never the browser's native dialog. Escape or a tap outside
  // cancels, Enter confirms; focus goes back where it was.
  function pageConfirm(text, done) {
    var prevFocus = document.activeElement;
    var wrap = document.createElement('div');
    wrap.className = 'confirm-backdrop';
    wrap.innerHTML = '<div class="confirm-sheet" role="dialog" aria-modal="true">'
      + '<div class="confirm-text"></div>'
      + '<div class="prop-actions"><button class="ghost" data-ok="0">Cancel</button><button data-ok="1">OK</button></div>'
      + '</div>';
    wrap.querySelector('.confirm-text').textContent = text;
    wrap.querySelector('.confirm-sheet').setAttribute('aria-label', String(text).split('\n')[0]);
    var closed = false;
    function close(ok) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus();
      done(ok);
    }
    function onKey(e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'Enter' && !(e.target.closest && e.target.closest('button') && wrap.contains(e.target))) { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') {
        var btns = wrap.querySelectorAll('button');
        e.preventDefault();
        (document.activeElement === btns[1] ? btns[0] : btns[1]).focus();
      }
    }
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) return close(false);
      var b = e.target.closest('[data-ok]');
      if (b) close(b.getAttribute('data-ok') === '1');
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-ok="1"]').focus();
  }

  function removeFile(id) {
    var f = detailRec(id);
    if (!f || files.busy) return;
    confirmThen('Remove "' + fileTitle(f) + '" from your files?', async function () {
      files.busy = true;
      try {
        await app.api('files/' + encodeURIComponent(id) + '/remove', { method: 'POST', body: {} });
        app.haptic('success');
        files.list = files.list.filter(function (x) { return x.id !== id; });
        if (files.counts && files.counts[f.kind] > 0) files.counts[f.kind]--;
        if (files.openId) closeDetail();
        loadFiles();
      } catch (e) {
        app.haptic('error');
        setStatus('error', e.message);
      } finally {
        files.busy = false;
      }
    });
  }

  // --- the queue ---------------------------------------------------------------

  function renderList() {
    if (tab === 'files') { renderFiles(); return; }
    if (tab === 'briefing') { renderBriefing(); return; }
    if (tab === 'mail') { renderMail(); return; }
    if (tab === 'calendar') { renderCalendar(); return; }
    if (!lastList.length) {
      queueEl.innerHTML = '<div class="empty">Nothing waiting for you.</div>';
      return;
    }
    var fresh = lastList.filter(function (p) { return !isStale(p); });
    var stale = lastList.filter(isStale);
    queueEl.innerHTML = groupBlock('Fresh', fresh, false) + groupBlock('Waiting over 48 h', stale, true);
  }

  // --- detail ------------------------------------------------------------------

  function convertButtons(p) {
    if (!p.prior) return '';
    var out = '';
    if (p.prior.suggested) out += '<button class="ghost" data-convert="update">Update the existing one instead</button>';
    if (p.prior.original) out += '<button class="ghost" data-convert="create">Create a separate one instead</button>';
    return out;
  }

  function editorFor(p) {
    var payload = p.payload || {};
    var rows = Object.keys(payload).map(function (k) {
      var v = payload[k];
      if (v && typeof v === 'object') {
        return '<div><label class="me-label">' + esc(k) + ' (JSON)</label>'
          + '<textarea class="me-body" data-f="' + esc(k) + '" data-json="1">' + esc(JSON.stringify(v, null, 2)) + '</textarea></div>';
      }
      if (typeof v === 'boolean') {
        return '<div><label class="me-label">' + esc(k) + '</label>'
          + '<select class="me-input" data-f="' + esc(k) + '" data-bool="1">'
          + '<option value="true"' + (v ? ' selected' : '') + '>Yes</option>'
          + '<option value="false"' + (v ? '' : ' selected') + '>No</option></select></div>';
      }
      var s = v == null ? '' : String(v);
      var long = s.length > 80 || k === 'body' || k === 'notes' || k === 'text';
      return '<div><label class="me-label">' + esc(k) + '</label>'
        + (long
          ? '<textarea class="me-body" data-f="' + esc(k) + '">' + esc(s) + '</textarea>'
          : '<input class="me-input" data-f="' + esc(k) + '" value="' + esc(s) + '">')
        + '</div>';
    }).join('');
    return '<div class="prop-editor">' + rows
      + '<div class="prop-actions"><button data-edit-save>Save changes</button>'
      + '<button class="ghost" data-edit-cancel>Cancel</button></div>'
      + '<span class="me-note" data-edit-note></span></div>';
  }

  var SRC_MISSING = {
    engine: 'The mail engine is not running, so the original email cannot be shown.',
    gone: 'That email is no longer in the mailbox — it was moved or deleted.',
    proposal: 'This proposal is no longer available.',
    none: 'This proposal did not come from an email.',
    error: 'The original email could not be read.',
  };

  function renderSourceMail(r, headText) {
    var head = '<div class="po-source-head">✉ ' + esc(headText || 'The email this came from') + '</div>';
    if (!r) return head + '<div class="tl-note">Loading…</div>';
    if (r.missing) return head + '<div class="tl-note">' + esc(SRC_MISSING[r.missing] || SRC_MISSING.error) + '</div>';
    var m = r.email || {};
    var when = m.date ? new Date(m.date) : null;
    var row = function (label, val) {
      return val ? '<div class="mail-row"><span class="mail-label">' + label + '</span><span class="mail-val">' + esc(val) + '</span></div>' : '';
    };
    return head + '<div class="mail-card">'
      + row('From', m.from) + row('To', m.to)
      + row('Date', when && !isNaN(when) ? when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : m.date)
      + '<div class="mail-subject">' + esc(m.subject || '(no subject)') + '</div>'
      + '<div class="mail-body">' + PC.renderBody(m.body) + '</div>'
      + (m.truncated ? '<button class="ghost" data-src-full>Show the whole email (' + esc(String(m.chars)) + ' characters)</button>' : '')
      + ((m.attachments || []).length
        ? '<div>' + m.attachments.map(function (a) { return '<span class="att-chip">📎 ' + esc(a.filename || 'attachment') + '</span>'; }).join('') + '</div>'
        : '')
      + '</div>';
  }

  // The signature switch. A card is a read-only descriptor, so the affordance
  // lives in the action row beside the buttons — the same placement the GUI
  // uses. Tapping it posts the FLAG, never a body: the server's compose hook
  // re-stitches both MIME parts from the payload's own sources, so this surface
  // cannot freeze a body that disagrees with the flag it just set.
  function sigToggle(p) {
    var pl = p.payload || {};
    if (typeof pl.replyText !== 'string') return '';
    if (!pl.signatureText && !pl.signatureHtml) return '';
    return '<label class="sig-check"><input type="checkbox" data-sig'
      + (pl.includeSignature ? ' checked' : '') + '> Signature</label>';
  }

  function renderDetail() {
    var p = byId(openId);
    if (!p) { closeDetail(); return; }
    if (editing) return; // never re-render mid-typing

    var canUndo = p.status === 'executed' && p.result && p.result.eventId;
    var actions = p.status === 'pending'
      ? '<div class="prop-actions">'
        + '<button data-decide="approve">✅ Approve</button>'
        + '<button class="deny" data-decide="deny">✖ Deny</button>'
        + '<button class="ghost" data-edit>✎ Edit</button>'
        + '<button class="ghost" data-withdraw>↩ Withdraw</button>'
        + convertButtons(p)
        + sigToggle(p)
        + '</div>'
      : (canUndo ? '<div class="prop-actions"><button class="ghost" data-undo>↩ Undo this</button></div>' : '');

    // data-version: the payload version this render shows — what an approve
    // sends, so one landing after an edit is refused instead of approving
    // something the owner never saw.
    detailEl.innerHTML = '<div class="prop" data-id="' + esc(p.id) + '" data-version="' + esc(p.version || '') + '">'
      + '<div class="prop-top"><span class="prop-kind">' + esc(p.kind) + (p.app ? ' · ' + esc(p.app) : '')
      + '</span><span class="prop-age">' + esc(ageLabel(ageOf(p))) + '</span></div>'
      + priorBlock(p)
      + notesBlock(p)
      + sourceBanner(p)
      + (p.detail ? '<div class="prop-detail">' + esc(p.detail) + '</div>' : '')
      + PC.renderDescriptorCard(p.card)
      + diffBlock(p)
      + conflictsBlock(p)
      + (editing ? editorFor(p) : actions)
      + '<div class="po-source">' + renderSourceMail(sourceCache[p.id]) + '</div>'
      + '</div>';

    syncChrome();
    if (sourceCache[p.id] === undefined) loadSource(p.id, false);
    var day = whenDateOf(p);
    if (day && dayCache[day] === undefined) loadDay(day);
  }

  // What else is already on the day a calendar proposal wants. The machine
  // twin (field.iso.date) travels beside the human label precisely so a
  // surface can ask this without re-parsing a formatted string.
  function whenDateOf(p) {
    var fields = (p.card && p.card.fields) || [];
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].kind === 'when' && fields[i].iso && fields[i].iso.date) return fields[i].iso.date;
    }
    return null;
  }

  function conflictsBlock(p) {
    var day = whenDateOf(p);
    if (!day) return '';
    var d = dayCache[day];
    if (d === undefined || d === null) return '<div class="po-source"><div class="po-source-head">📅 That day</div><div class="tl-note">Loading…</div></div>';
    var evs = (d.events || []);
    return '<div class="po-source"><div class="po-source-head">📅 Already on ' + esc(formatDayLabel(day)) + '</div>'
      + (evs.length ? evs.map(eventRow).join('') : '<div class="tl-note">Nothing else that day.</div>')
      + '</div>';
  }

  async function loadDay(day) {
    if (dayCache[day] === null) return;
    dayCache[day] = null;
    try {
      dayCache[day] = await app.api('calendar/day?date=' + encodeURIComponent(day));
    } catch (e) {
      dayCache[day] = { events: [] };
    }
    if (openId) renderDetail();
  }

  async function loadSource(id, full) {
    // Mark in-flight (null, not undefined) so the 5 s poll's re-render does not
    // re-issue the same request on every tick until it resolves.
    if (sourceCache[id] === null && !full) return;
    sourceCache[id] = null;
    try {
      var r = await app.api('proposals/' + encodeURIComponent(id) + '/source' + (full ? '?full=1' : ''));
      sourceCache[id] = r;
    } catch (e) {
      sourceCache[id] = { missing: 'error' };
    }
    if (openId === id) renderDetail();
  }

  function openDetail(id) {
    openId = id;
    editing = false;
    queueEl.hidden = true;
    detailEl.hidden = false;
    renderDetail();
  }

  function closeDetail() {
    openId = null;
    // Also clears the mail detail: without this, backing out of a message
    // leaves openUid set and every later mail render is silently skipped.
    mail.openUid = null;
    files.openId = null;
    files.detail = null;
    editing = false;
    detailEl.hidden = true;
    queueEl.hidden = false;
    renderList();
    syncChrome();
  }

  // Telegram's own chrome: BackButton for list↔detail, MainButton as the
  // primary approve so the commonest action is under the thumb.
  function syncChrome() {
    if (!tg) return;
    var p = openId ? byId(openId) : null;
    try {
      // A mail detail has no proposal, but it still needs a way back.
      if (p || mail.openUid || files.openId) tg.BackButton.show(); else tg.BackButton.hide();
      if (p && p.status === 'pending' && !editing) {
        tg.MainButton.setText('✅ Approve');
        tg.MainButton.show();
      } else {
        tg.MainButton.hide();
      }
    } catch (e) { /* older Telegram clients */ }
  }

  // --- actions -----------------------------------------------------------------

  async function act(id, fn, okHaptic) {
    if (busy[id]) return;
    busy[id] = true;
    try {
      await fn();
      app.haptic(okHaptic || 'success');
      delete sourceCache[id];
      await poll();
      if (openId === id) {
        var still = byId(id);
        if (!still) closeDetail(); else renderDetail();
      }
    } catch (e) {
      app.haptic('error');
      setStatus('error', e.message);
      // Re-render what the server holds now (a refused stale approve, a card
      // decided elsewhere); the error stays in the status line.
      poll().then(function () { setStatus('error', e.message); });
    } finally {
      delete busy[id];
    }
  }

  // The version the open detail rendered (data-version); a stale one is
  // refused by the server, and act()'s error path re-polls the current card.
  function shownVersion(id) {
    var el = detailEl.querySelector('.prop[data-id]');
    return el && el.getAttribute('data-id') === id ? el.getAttribute('data-version') : null;
  }

  function decide(id, decision) {
    var version = shownVersion(id);
    return act(id, function () {
      return app.api('proposals/' + encodeURIComponent(id) + '/decide', { method: 'POST', body: { decision: decision, version: version } });
    }, decision === 'approve' ? 'success' : 'warning');
  }

  async function runBulk(action, ids) {
    if (!ids.length) return;
    try {
      var r = await app.api('proposals/batch', { method: 'POST', body: { action: action, ids: ids } });
      app.haptic(r.failed ? 'warning' : 'success');
      if (r.failed) setStatus('error', r.failed + ' of ' + ids.length + ' could not be done');
      await poll();
    } catch (e) {
      app.haptic('error');
      setStatus('error', e.message);
    }
  }

  function collectEdits(root) {
    var out = {};
    var fields = root.querySelectorAll('[data-f]');
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var key = f.getAttribute('data-f');
      if (f.getAttribute('data-bool')) out[key] = f.value === 'true';
      else if (f.getAttribute('data-json')) out[key] = JSON.parse(f.value); // throws → surfaced below
      else out[key] = f.value;
    }
    return out;
  }

  // --- events ------------------------------------------------------------------

  function selectTab(name) {
    tab = name;
    titleEl.textContent = TAB_TITLES[tab];
    var all = tabsEl.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) all[i].classList.toggle('active', all[i].getAttribute('data-tab') === name);
    mail.openUid = null;
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;

    var tabBtn = t.closest ? t.closest('#tabs button') : null;
    if (tabBtn) {
      selectTab(tabBtn.getAttribute('data-tab'));
      closeDetail();
      // Read-only views load on demand rather than on the 5 s approvals poll.
      if (tab === 'mail' && !mail.loaded) loadMail();
      if (tab === 'calendar' && !cal.data) loadCalendar();
      if (tab === 'briefing' && !brief.loaded) loadBriefing();
      if (tab === 'files') loadFiles();
      return;
    }

    var fkindBtn = t.closest ? t.closest('[data-fkind]') : null;
    if (fkindBtn) { setFileKind(fkindBtn.getAttribute('data-fkind')); return; }
    if (t.closest && t.closest('[data-file-back]')) { closeDetail(); return; }
    var sibBtn = t.closest ? t.closest('[data-file-sib]') : null;
    if (sibBtn) { showSibling(sibBtn.getAttribute('data-file-sib')); return; }
    var dlBtn = t.closest ? t.closest('[data-file-download]') : null;
    if (dlBtn) { downloadFile(ev, dlBtn.getAttribute('data-file-download')); return; }
    var rmBtn = t.closest ? t.closest('[data-file-remove]') : null;
    if (rmBtn) { removeFile(rmBtn.getAttribute('data-file-remove')); return; }
    var fullImg = t.closest ? t.closest('[data-file-full]') : null;
    if (fullImg) { openFull(fullImg.getAttribute('data-file-full')); return; }
    var fileRowEl = t.closest ? t.closest('[data-file]') : null;
    if (fileRowEl && !files.openId) { openFile(fileRowEl.getAttribute('data-file'), false); return; }

    var dayBtn = t.closest ? t.closest('[data-day]') : null;
    if (dayBtn) {
      cal.date = shiftDay(cal.date || todayLocal(), Number(dayBtn.getAttribute('data-day')));
      cal.data = null;
      renderCalendar();
      loadCalendar();
      return;
    }

    var mailBtn = t.closest ? t.closest('[data-mail]') : null;
    if (mailBtn) { openMail(mailBtn.getAttribute('data-mail')); return; }

    var bulkBtn = t.closest ? t.closest('[data-bulk]') : null;
    if (bulkBtn) {
      // Bounded to the ids this page is currently showing — never "everything
      // on the server", which a stale page could otherwise sweep away.
      var ids = lastList.filter(isStale).map(function (p) { return p.id; });
      runBulk(bulkBtn.getAttribute('data-bulk'), ids);
      return;
    }

    var row = t.closest ? t.closest('.prop[data-id]') : null;
    var id = row ? row.getAttribute('data-id') : null;

    if (t.closest && t.closest('[data-decide]')) { decide(id, t.closest('[data-decide]').getAttribute('data-decide')); return; }
    if (t.closest && t.closest('[data-withdraw]')) {
      act(id, function () { return app.api('proposals/batch', { method: 'POST', body: { action: 'withdraw', ids: [id] } }); }, 'warning');
      return;
    }
    if (t.closest && t.closest('[data-undo]')) {
      act(id, function () { return app.api('proposals/' + encodeURIComponent(id) + '/undo', { method: 'POST', body: {} }); });
      return;
    }
    if (t.closest && t.closest('[data-convert]')) {
      var to = t.closest('[data-convert]').getAttribute('data-convert');
      act(id, function () { return app.api('proposals/' + encodeURIComponent(id) + '/convert', { method: 'POST', body: { to: to } }); });
      return;
    }
    if (t.closest && t.closest('[data-sig]')) {
      var box = t.closest('[data-sig]');
      var sp = byId(openId);
      if (!sp) return;
      var want = !!box.checked;
      act(openId, function () {
        var next = {};
        for (var k in sp.payload) { if (Object.prototype.hasOwnProperty.call(sp.payload, k)) next[k] = sp.payload[k]; }
        next.includeSignature = want;
        return app.api('proposals/' + encodeURIComponent(openId) + '/payload', { method: 'POST', body: { payload: next } });
      });
      return;
    }
    if (t.closest && t.closest('[data-edit]')) { editing = true; renderDetail(); syncChrome(); return; }
    if (t.closest && t.closest('[data-edit-cancel]')) { editing = false; renderDetail(); return; }
    if (t.closest && t.closest('[data-src-full]')) { loadSource(openId, true); return; }
    if (t.closest && t.closest('[data-edit-save]')) {
      var host = t.closest('.prop');
      var note = host.querySelector('[data-edit-note]');
      var payload;
      try { payload = collectEdits(host); }
      catch (e) { if (note) note.textContent = 'That JSON field is not valid.'; return; }
      editing = false;
      act(openId, function () {
        return app.api('proposals/' + encodeURIComponent(openId) + '/payload', { method: 'POST', body: { payload: payload } });
      });
      return;
    }

    // A tap anywhere else on a list row opens it.
    if (row && !openId) openDetail(id);
  });

  if (tg) {
    try {
      tg.BackButton.onClick(closeDetail);
      tg.MainButton.onClick(function () { if (openId) decide(openId, 'approve'); });
    } catch (e) { /* older Telegram clients */ }
  }

  // --- polling -----------------------------------------------------------------

  async function poll() {
    // The files list refreshes with the poll (fresh tickets), but never under
    // an open detail: re-rendering would stop a playing <audio>/<video>.
    if (tab === 'files' && !files.openId) loadFiles();
    if (editing) return; // a refresh mid-edit would discard what was typed
    try {
      var data = await app.api('proposals');
      lastList = data.proposals || [];
      setStatus('ready', lastList.length ? lastList.length + ' waiting' : 'all clear');
      if (openId) renderDetail(); else renderList();
    } catch (e) {
      setStatus('error', e.message === 'unauthorized' ? 'not authorized' : 'connection lost');
    }
  }

  // Deep links from a delivery notice: ?file=<dl_id> opens that file,
  // ?files=<kind> opens the list filtered. The file fetch waits for boot so it
  // rides the exchanged token instead of racing a second auth.
  var params = new URLSearchParams(location.search);
  var deepFile = params.get('file');
  var deepKind = params.get('files');
  if (deepFile || deepKind) {
    if (isFileKind(deepKind)) files.kind = deepKind;
    selectTab('files');
    renderFiles();
    if (deepFile) {
      // Set before boot so the first poll does not render the list over it.
      files.openId = deepFile;
      queueEl.hidden = true;
      detailEl.hidden = false;
      detailEl.innerHTML = '<div class="prop"><div class="tl-note">Loading…</div></div>';
    }
  }

  app.boot(poll, POLL_MS).then(function () {
    if (deepFile && files.openId === deepFile) openFile(deepFile, true);
  });
})();
