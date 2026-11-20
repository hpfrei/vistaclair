// === Remote sessions — views for the master's peers panel (Pro) ===
// Pure HTML builders for the "Remote sessions" section under each linked
// slave (Setup → Remote) and the "Launch on <slave>" form. publish.js owns
// the state, the WS messages and the event wiring (docs/remote-sessions.md).
//
// Every string that came from a slave (titles, app names, errors, alert
// text, email / orgName) is untrusted: capped with capText and escaped with
// esc — never raw HTML, never markdown.
(function (root) {
  'use strict';

  const CAP = { title: 120, app: 64, short: 40, account: 120, text: 300 };
  const APP_RE = /^[a-z0-9][a-z0-9-]*$/;
  const MODEL_RE = /^[A-Za-z0-9._-]{1,80}(\[1m\])?$/;

  // Control characters flattened, trimmed, cut to `max` chars with an ellipsis.
  function capText(s, max) {
    if (typeof s !== 'string') return '';
    const flat = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    const chars = Array.from(flat);
    return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : flat;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const txt = (s, max = CAP.short) => esc(capText(s, max));

  // HTML-safe: the "<$0.01" case comes back escaped.
  function fmtUsd(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '$0.00';
    return v < 0.01 ? '&lt;$0.01' : '$' + v.toFixed(2);
  }

  // Why the whole launch form is off, or null. `view` is the peer's entry of
  // app:peer:sessions:state.
  function launchBlocked(view, slave) {
    if (!view) return `${slave} is not reporting remote-session state`;
    if (!view.connected) return `the channel to ${slave} is down`;
    if (!view.claude) return `${slave} has not reported its Claude status yet`;
    if (!view.claude.remoteSessions?.enabled) return `enable remote sessions on ${slave}'s own dashboard`;
    return null;
  }

  // The two billing choices from the slave's `claude` block; an option the
  // slave cannot honour is disabled with the reason.
  function billingOptions(claude, slave) {
    const c = claude || {};
    const sub = { value: 'subscription', label: 'Subscription', disabled: false, reason: '', note: '' };
    if (!c.loggedIn) { sub.disabled = true; sub.reason = 'not signed in'; }
    const key = { value: 'apikey', label: 'API key', disabled: false, reason: '', note: 'billed per token' };
    if (!c.apiKey) { key.disabled = true; key.reason = `no API key on ${slave}`; }
    else if (!c.remoteSessions?.allowApiKey) { key.disabled = true; key.reason = `API key not allowed by ${slave}`; }
    return [sub, key];
  }

  // The option checked by default: the slave's own preference when it is
  // offered, else the first enabled one, else null.
  function defaultBilling(claude, options) {
    const pref = claude?.pref === 'apikey' || claude?.pref === 'api-key' ? 'apikey' : claude?.pref === 'subscription' ? 'subscription' : null;
    const usable = options.filter((o) => !o.disabled);
    return (usable.find((o) => o.value === pref) || usable[0] || null)?.value || null;
  }

  const ERRORS = {
    disabled: (s) => `Remote sessions are off on ${s} — enable them on ${s}'s own dashboard.`,
    'not-https': (s) => `${s} is not reached over HTTPS — remote sessions need TLS on the channel.`,
    'bad-app': (s) => `${s} refused that app (it must be an app deployed there).`,
    'no-credential': (s) => `${s} has no such credential — sign in on its dashboard, or sync the API key.`,
    'apikey-not-allowed': (s) => `${s} does not allow remote sessions on its API key.`,
    limit: (s) => `${s}'s remote-session limit is reached (3 at once, 10 per hour).`,
    'unknown-tab': (s) => `That session no longer exists on ${s}.`,
    'not-remote': (s) => `That tab is not a remote session on ${s}.`,
    'bad-args': () => 'The request was refused as malformed — check the app, the prompt and the model.',
    offline: (s) => `${s} is offline (no live channel).`,
    timeout: (s) => `${s} did not answer in time.`,
    disconnected: (s) => `The channel to ${s} dropped before it answered.`,
    'unknown-peer': (s) => `${s} is not a linked slave.`,
    unavailable: () => 'Remote sessions are unavailable on this master.',
    'not-master': () => 'This instance is a slave: remote sessions are launched from the master.',
    'not-owner': () => 'Only the owner may launch or stop remote sessions.',
  };

  // Human text for a refusal code. An unknown code shows the server's message
  // (it may carry the slave's), capped — callers escape it like everything else.
  function errorText(code, slave, message) {
    const f = ERRORS[code];
    if (f) return f(slave);
    return `Refused (${capText(code, CAP.short) || 'error'}): ${capText(message, CAP.text) || 'unknown error'}`;
  }

  // The slave's deployed apps from its fleet snapshot, sorted, names only.
  function appsFromFleet(fleet) {
    const names = new Set([...Object.keys(fleet?.deployed || {}), ...Object.keys(fleet?.appHealth || {})]);
    return [...names].filter((a) => APP_RE.test(a) && a.length <= CAP.app).sort();
  }

  function credentialBadge(credential) {
    if (credential === 'api-key') return '<span class="rs-cred apikey" title="Billed per token to the slave\'s API key">API key</span>';
    if (credential === 'subscription') return '<span class="rs-cred sub" title="Billed to the slave\'s Claude subscription">Subscription</span>';
    return '<span class="rs-cred">—</span>';
  }

  function sessionRowHtml(s) {
    const title = capText(s.title, CAP.title) || capText(s.app, CAP.app) || '(untitled)';
    const state = s.running ? capText(s.state, CAP.short) || 'running' : `exited${Number.isFinite(s.exitCode) ? ' ' + s.exitCode : ''}`;
    const tabId = esc(capText(s.tabId, 200));
    return `
      <div class="rs-session${s.running ? '' : ' exited'}">
        <span class="rs-session-title">${esc(title)}</span>
        <span class="rs-session-meta">${txt(s.app, CAP.app)} · ${txt(s.role || s.mode || 'simple')} · <span class="rs-state">${esc(state)}</span></span>
        ${credentialBadge(s.credential || (s.auth === 'apikey' ? 'api-key' : s.auth))}
        <span class="rs-cost">${fmtUsd(s.costUsd)}</span>
        ${s.tab ? `<button class="setup-btn" data-act="rs-open" data-tab="${tabId}">Open tab</button>` : ''}
        ${s.running ? `<button class="setup-btn setup-btn-danger" data-act="rs-kill" data-tab="${tabId}">Kill</button>` : ''}
      </div>`;
  }

  function accountLine(claude, sameAccount) {
    if (!claude) return '';
    const who = [capText(claude.email, CAP.account), capText(claude.orgName, CAP.account)].filter(Boolean).join(' · ');
    const signed = claude.loggedIn ? `signed in${who ? ' as ' + esc(who) : ''}` : 'not signed in';
    const same = sameAccount === true
      ? '<div class="rs-same-account">Same Claude account as this master — shares one usage limit.</div>' : '';
    return `<div class="rs-line">Claude: ${signed} · API key ${claude.apiKey ? 'stored' : 'none'}</div>${same}`;
  }

  function totalsLine(totals) {
    const t = totals || {};
    const hits = Number.isFinite(t.limitHits) && t.limitHits > 0 ? Math.floor(t.limitHits) : 0;
    return `<div class="rs-line rs-totals">Billed since this master started: API key ${fmtUsd(t.apiKeyUsd)} · Subscription ${fmtUsd(t.subscriptionUsd)} · ${hits} usage-limit hit${hits === 1 ? '' : 's'}</div>`;
  }

  // peer → alert from app:peer:sessions:state (the server keeps the last one
  // per peer until dismissed); peers without one are absent.
  function alertsFromState(peers) {
    const out = {};
    for (const p of Array.isArray(peers) ? peers : []) {
      if (p && typeof p.peer === 'string' && p.alert && typeof p.alert === 'object') out[p.peer] = p.alert;
    }
    return out;
  }

  // A peer's auth alert on its row: a fixed headline from the master plus the
  // slave's own text as a capped line of text. No login is relayed.
  function alertHtml(alert, slave) {
    if (!alert) return '';
    const detail = capText(alert.text, CAP.text);
    const problem = capText(alert.problem, CAP.short);
    const when = Number.isFinite(alert.at) && alert.at > 0 ? new Date(alert.at).toLocaleString() : '';
    return `
      <div class="rs-alert" role="alert">
        <div class="rs-alert-head">Claude sign-in expired on ${esc(slave)} — sign in on its dashboard, or sync the API key.${when ? ` <span class="rs-alert-when">${esc(when)}</span>` : ''}</div>
        ${detail || problem ? `<div class="rs-alert-detail">${esc(detail)}${problem ? ` <span class="rs-alert-code">(${esc(problem)})</span>` : ''}</div>` : ''}
        <div class="rs-alert-actions">
          <button class="setup-btn" data-act="rs-synckeys">Sync keys</button>
          <button class="setup-btn" data-act="rs-dismiss">Dismiss</button>
        </div>
      </div>`;
  }

  // "Sessions on this slave may join runs" (peer-remote-host.js): the master's
  // own switch per slave, and why runs cannot use the slave now. `runs` is the
  // peer's entry of app:peer:sessions:state; absent on an older server.
  function joinRunsHtml(runs, slave) {
    if (!runs) return '';
    const why = runs.allowed && !runs.available && runs.reason ? `<span class="rs-hint"> — runs cannot use ${txt(slave)} now: ${txt(runs.reason, CAP.text)}</span>` : '';
    return `<div class="rs-line rs-joinruns"><label><input type="checkbox" data-act="rs-joinruns" ${runs.allowed ? 'checked' : ''}> Sessions on this slave may join runs</label>${why}</div>`;
  }

  // The whole section for one slave. opts: { alert, notice, error }.
  function sectionHtml(view, slave, opts = {}) {
    const blocked = launchBlocked(view, slave);
    const sessions = Array.isArray(view?.sessions) ? view.sessions : [];
    const noTab = sessions.some((s) => !s.tab);
    return `
      <div class="rs-section">
        <div class="rs-head">
          <span class="rs-title">Remote sessions</span>
          <button class="setup-btn setup-btn-primary" data-act="rs-launch" ${blocked ? 'disabled' : ''}>Launch on ${esc(slave)}</button>
        </div>
        ${blocked ? `<div class="rs-line rs-blocked">${esc(blocked)}</div>` : ''}
        ${joinRunsHtml(view?.runs, slave)}
        ${alertHtml(opts.alert, slave)}
        ${accountLine(view?.claude, view?.sameAccount)}
        ${totalsLine(view?.totals)}
        ${sessions.length ? `<div class="rs-sessions">${sessions.map(sessionRowHtml).join('')}</div>` : '<div class="rs-line">No remote sessions on this slave.</div>'}
        ${noTab ? '<div class="rs-line rs-hint">Tab view needs the core update — state and cost only.</div>' : ''}
        ${opts.notice ? `<div class="rs-line rs-notice ${opts.notice.level === 'error' ? 'bad' : ''}">${txt(opts.notice.text, CAP.text)}</div>` : ''}
        ${opts.error ? `<div class="rs-line rs-notice bad">${txt(opts.error, CAP.text)}</div>` : ''}
      </div>`;
  }

  // The launch form's body. models: [{ value, label }] (master's picker list).
  function launchFormHtml(view, slave, { apps = [], models = [] } = {}) {
    const blocked = launchBlocked(view, slave);
    if (blocked) return `<div class="publish-error">${esc(blocked)}</div>`;
    const options = billingOptions(view.claude, slave);
    const checked = defaultBilling(view.claude, options);
    const appOpts = apps.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    const modelOpts = models
      .filter((m) => typeof m?.value === 'string' && MODEL_RE.test(m.value))
      .map((m) => `<option value="${esc(m.value)}">${esc(capText(m.label || m.value, CAP.title))}</option>`).join('');
    const billing = options.map((o) => `
      <label class="publish-radio-row${o.disabled ? ' disabled' : ''}">
        <input type="radio" name="rsAuth" value="${o.value}" ${o.disabled ? 'disabled' : ''} ${o.value === checked ? 'checked' : ''}>
        <span>${o.label}
          ${o.disabled ? `<span class="publish-radio-note">${esc(o.reason)}</span>` : ''}
          ${o.note && !o.disabled ? `<span class="publish-radio-note rs-billed">${o.note} to ${esc(slave)}'s API key</span>` : ''}
        </span>
      </label>`).join('');
    return `
      <div class="publish-section">
        <div class="publish-section-title">Mode</div>
        <label class="publish-radio-row"><input type="radio" name="rsMode" value="simple" checked><span>Simple <span class="publish-radio-note">one Agent SDK session</span></span></label>
        <label class="publish-radio-row"><input type="radio" name="rsMode" value="orchestrator"><span>Orchestrator <span class="publish-radio-note">an orchestrator that runs workers on ${esc(slave)}</span></span></label>
      </div>
      <div class="publish-section">
        <div class="publish-section-title">App</div>
        ${apps.length ? `<select id="rsApp" class="publish-select">${appOpts}</select>` : `<div class="publish-error">No deployed apps reported by ${esc(slave)} — publish one first.</div>`}
      </div>
      <div class="publish-section">
        <div class="publish-section-title">Prompt</div>
        <textarea id="rsPrompt" class="publish-input rs-prompt" rows="6" maxlength="32768" placeholder="What the session should do"></textarea>
      </div>
      <div class="publish-section">
        <div class="publish-section-title">Model <span class="publish-section-note">optional</span></div>
        <select id="rsModel" class="publish-select"><option value="">${esc(slave)}'s default</option>${modelOpts}</select>
      </div>
      <div class="publish-section">
        <div class="publish-section-title">Billing</div>
        ${billing}
        ${view.sameAccount === true ? '<div class="publish-warn">Same Claude account as this master — a subscription session shares one usage limit.</div>' : ''}
      </div>`;
  }

  const api = {
    capText, esc, fmtUsd, launchBlocked, billingOptions, defaultBilling, errorText, appsFromFleet,
    sessionRowHtml, alertsFromState, alertHtml, joinRunsHtml, sectionHtml, launchFormHtml, CAP,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.remoteSessionsView = api;
})(typeof window !== 'undefined' ? window : globalThis);
