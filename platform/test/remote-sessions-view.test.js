// Remote sessions views (public/remote-sessions-view.js): billing options
// from a slave's claude block, the disabled form, escaping of slave strings,
// totals and the same-account note.
const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../public/remote-sessions-view');

const HOSTILE = '<img src=x onerror=alert(1)>';
const claude = (over = {}) => ({
  loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'a@b.c', orgName: null,
  apiKey: true, pref: null, remoteSessions: { enabled: true, allowApiKey: true }, ...over,
});
const view = (over = {}) => ({
  peer: 'hz1', connected: true, claude: claude(), sameAccount: null,
  totals: { apiKeyUsd: 0, subscriptionUsd: 0, limitHits: 0 }, sessions: [], ...over,
});
const byValue = (opts) => Object.fromEntries(opts.map((o) => [o.value, o]));

test('billing options: both offered, API key carries the per-token note', () => {
  const o = byValue(v.billingOptions(claude(), 'hz1'));
  assert.equal(o.subscription.disabled, false);
  assert.equal(o.apikey.disabled, false);
  assert.equal(o.apikey.note, 'billed per token');
  assert.equal(v.defaultBilling(claude({ pref: 'apikey' }), Object.values(o)), 'apikey');
  assert.equal(v.defaultBilling(claude(), Object.values(o)), 'subscription');
});

test('billing options: each disabled reason', () => {
  assert.equal(byValue(v.billingOptions(claude({ loggedIn: false }), 'hz1')).subscription.reason, 'not signed in');
  assert.equal(byValue(v.billingOptions(claude({ apiKey: false }), 'hz1')).apikey.reason, 'no API key on hz1');
  const notAllowed = byValue(v.billingOptions(claude({ remoteSessions: { enabled: true, allowApiKey: false } }), 'hz1'));
  assert.equal(notAllowed.apikey.disabled, true);
  assert.equal(notAllowed.apikey.reason, 'API key not allowed by hz1');
  const none = v.billingOptions(claude({ loggedIn: false, apiKey: false }), 'hz1');
  assert.equal(v.defaultBilling(claude(), none), null);
  const html = v.launchFormHtml(view({ claude: claude({ loggedIn: false, apiKey: false }) }), 'hz1', { apps: ['notes'] });
  assert.match(html, /value="subscription" disabled/);
  assert.match(html, /value="apikey" disabled/);
  assert.match(html, /no API key on hz1/);
});

test('API key option shows "billed per token" in the form', () => {
  const html = v.launchFormHtml(view(), 'hz1', { apps: ['notes'], models: [{ value: 'claude-opus-4-1', label: 'Opus' }, { value: 'bad model"><x>', label: 'x' }] });
  assert.match(html, /billed per token to hz1's API key/);
  assert.match(html, /value="claude-opus-4-1"/);
  assert.doesNotMatch(html, /bad model/);
});

test('remote sessions disabled on the slave disables the whole form', () => {
  const off = view({ claude: claude({ remoteSessions: { enabled: false, allowApiKey: false } }) });
  const reason = "enable remote sessions on hz1's own dashboard";
  assert.equal(v.launchBlocked(off, 'hz1'), reason);
  const form = v.launchFormHtml(off, 'hz1', { apps: ['notes'] });
  assert.doesNotMatch(form, /<textarea|<select|type="radio"/);
  assert.ok(form.includes(v.esc(reason)));
  const section = v.sectionHtml(off, 'hz1');
  assert.match(section, /data-act="rs-launch" disabled/);
  assert.equal(v.launchBlocked(view({ connected: false }), 'hz1'), 'the channel to hz1 is down');
  assert.ok(v.launchBlocked(view({ claude: null }), 'hz1'));
  assert.equal(v.launchBlocked(view(), 'hz1'), null);
});

test('hostile slave strings stay text', () => {
  const s = {
    tabId: 'peer-hz1-t"1', title: HOSTILE, app: HOSTILE, role: HOSTILE, state: HOSTILE,
    running: true, credential: 'api-key', costUsd: 1.234, tab: false,
  };
  const html = v.sectionHtml(view({
    claude: claude({ email: HOSTILE, orgName: HOSTILE }), sessions: [s],
  }), 'hz1', {
    alert: { problem: HOSTILE, text: HOSTILE },
    notice: { level: 'error', text: HOSTILE },
    error: v.errorText('weird', 'hz1', HOSTILE),
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-tab="peer-hz1-t&quot;1"/);
  assert.match(html, /Claude sign-in expired on hz1/);
  assert.match(html, /Tab view needs the core update/);
  assert.match(html, /\$1\.23/);
  // A hostile app name never reaches the launch form's app list.
  assert.deepEqual(v.appsFromFleet({ deployed: { notes: 'abc', [HOSTILE]: 'x' }, appHealth: { crm: 'ok' } }), ['crm', 'notes']);
  // Length caps.
  const long = v.sessionRowHtml({ ...s, title: 'x'.repeat(5000) });
  assert.ok(long.length < 2000);
});

test('totals and the same-account note', () => {
  const t = v.sectionHtml(view({ totals: { apiKeyUsd: 2.5, subscriptionUsd: 0.004, limitHits: 3 } }), 'hz1');
  assert.match(t, /API key \$2\.50/);
  assert.match(t, /Subscription &lt;\$0\.01/);
  assert.match(t, /3 usage-limit hits/);
  assert.match(v.sectionHtml(view({ sameAccount: true }), 'hz1'), /Same Claude account as this master — shares one usage limit/);
  assert.doesNotMatch(v.sectionHtml(view({ sameAccount: null }), 'hz1'), /Same Claude account/);
  assert.doesNotMatch(v.sectionHtml(view({ sameAccount: false }), 'hz1'), /Same Claude account/);
});

test('the peer alert comes from the state, escaped, with a dismiss button', () => {
  const peers = [
    view({ peer: 'hz1', alert: { problem: HOSTILE, text: HOSTILE, at: 1700000000000 } }),
    view({ peer: 'hz2', alert: null }),
    { peer: 42, alert: { text: 'x' } },
  ];
  const alerts = v.alertsFromState(peers);
  assert.deepEqual(Object.keys(alerts), ['hz1']);
  assert.deepEqual(v.alertsFromState(undefined), {});
  const html = v.sectionHtml(peers[0], 'hz1', { alert: alerts.hz1 });
  assert.match(html, /Claude sign-in expired on hz1/);
  assert.match(html, /data-act="rs-dismiss"/);
  assert.match(html, /class="rs-alert-when"/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(v.sectionHtml(peers[1], 'hz2', { alert: alerts.hz2 }), /rs-alert/);
});

test('refusal codes read as human text', () => {
  assert.match(v.errorText('disabled', 'hz1'), /enable them on hz1's own dashboard/);
  assert.match(v.errorText('apikey-not-allowed', 'hz1'), /does not allow/);
  assert.match(v.errorText('limit', 'hz1'), /limit is reached/);
  assert.match(v.errorText('nope', 'hz1', 'boom'), /Refused \(nope\): boom/);
});

test('an open-tab button only for a session registered with core', () => {
  const row = { tabId: 't1', title: 'T', app: 'notes', running: false, exitCode: 0, tab: true };
  assert.match(v.sessionRowHtml(row), /data-act="rs-open"/);
  assert.doesNotMatch(v.sessionRowHtml(row), /rs-kill/);
  assert.doesNotMatch(v.sessionRowHtml({ ...row, tab: false, running: true }), /rs-open/);
  assert.match(v.sessionRowHtml({ ...row, tab: false, running: true }), /rs-kill/);
});
