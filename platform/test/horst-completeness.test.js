// Phase 6 completeness audit — the invariant made a test: every owner mutation
// reachable over the dashboard WS maps to a governed kind, or sits on the
// explicit allowlist below. THE ALLOWLIST IS THE POLICY — reviewed, not
// accidental: adding a WS handler without classifying it here fails the suite.
//
// Also pins G8: lockout-risk / destructive / outward-facing kinds are
// ceiling-pinned to 'propose', remediation kinds may earn 'auto+notify', and
// the fleet kinds from phase 5D are actually registered (peer.kill on purpose
// is NOT — the kill-switch stays owner-click-only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const capabilities = require('../src/apps/capabilities');
const governance = require('../src/apps/governance/horst-governance');

const SRC = path.join(__dirname, '..', 'src', 'apps');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf-8');

function caseLabels(source) {
  const out = [];
  for (const m of source.matchAll(/case '(app:[^']+)':/g)) out.push(m[1]);
  return out;
}

// --- The classification -----------------------------------------------------
// kind:  the WS mutation has a governed twin — same implementation, proposal-
//        gated for AI principals (the owner click IS the approval).
// allow: owner-click-only, with the reason. The doctrine (06-horst-
//        completeness.md): secrets writes, auth/login flows, file-editor /
//        CLI-session writes, the peer kill-switch — plus owner-only control
//        planes (spend policy governs the AIs, so no AI may write it) and
//        idempotent inward diagnostics/probes.
// read:  no state change beyond caches/lazy idempotent provisioning.

const GOVERNED = {
  'app:create': 'app.create',
  'app:delete': 'app.delete',
  'app:rename': 'app.rename',
  'app:setConfig': 'app.setConfig',
  'app:setAutostart': 'app.setConfig', // autostart is a setConfig key on the kind path
  'app:updateDesc': 'app.setConfig', // description likewise
  'app:start': 'app.start',
  'app:stop': 'app.stop',
  'app:restart': 'app.restart',
  'app:setup:cronAdd': 'cron.set',
  'app:setup:cronUpdate': 'cron.set',
  'app:setup:cronRemove': 'cron.set',
  'app:setup:cronRun': 'cron.retry',
  'app:tasks:kill': 'spawn.kill',
  'app:setup:emailEngineSyncNow': 'email.sync.reconnect',
  // publish.js (phase 5D fleet kinds)
  'app:publish:start': 'app.publish',
  'app:publish:rollback': 'app.rollback',
  'app:publish:cancel': 'job.cancel', // publish jobs run as app-jobs
  'app:peer:syncKeys': 'peer.keys.sync',
  'app:peer:restart': 'peer.restart',
};

const ALLOW = {
  // Secrets / credential writes — owner-click-only by doctrine.
  'app:translateKey:set': 'secrets write (DeepL key)',
  'app:mapsKey:set': 'secrets write (Maps key)',
  'app:braveKey:set': 'secrets write (Brave key)',
  'app:elevenlabsKey:set': 'secrets write (ElevenLabs key)',
  'app:setup:oauthSave': 'secrets write (Google OAuth client)',
  'app:setup:oauthRevoke': 'auth flow (revoke Google account)',
  'app:setup:oauthReauth': 'auth flow (re-run OAuth)',
  'app:setup:oauthConnect': 'auth flow (first OAuth consent for a new account)',
  'app:setup:oauthReveal': 'secrets read-back (owner reveal)',
  'app:setup:emailAdd': 'secrets write (mail account credentials)',
  'app:setup:emailRemove': 'secrets write (mail account removal)',
  'app:setup:emailUpdate': 'secrets write (mail account credentials)',
  'app:setup:emailReveal': 'secrets read-back (owner reveal)',
  'app:setup:telegramSet': 'secrets write (bot token)',
  'app:setup:telegramRemove': 'secrets write (bot token removal)',
  'app:setup:telegramSetPublicUrl': 'auth topology (webhook URL)',
  'app:setup:telegramSetRestricted': 'auth flow (chat access control)',
  'app:setup:telegramRemoveChat': 'auth flow (chat access control)',
  'app:setup:whatsappSet': 'secrets write (Cloud API credentials)',
  'app:setup:whatsappRemove': 'secrets write (credential removal)',
  'app:setup:whatsappSetRestricted': 'auth flow (chat access control)',
  'app:setup:whatsappRemoveChat': 'auth flow (chat access control)',
  'app:setup:platformTelegramSet': 'secrets write (control-bot token)',
  'app:setup:platformTelegramRemove': 'secrets write (control-bot token removal)',
  'app:setup:platformTelegramSetRestricted': 'auth flow (control-bot access)',
  'app:setup:platformTelegramRemoveChat': 'auth flow (control-bot access)',
  // File-editor / CLI-session writes — G7: no AI write path into app dirs.
  'app:writeFile': 'file-editor write (G7 — AI edits go through change sessions)',
  'app:snapshot': 'file-editor companion (snapshot before manual edits)',
  'app:spawnCli': 'launches a CLI session (owner surface)',
  'app:changeRequest:decide': 'the owner answers one app asking another for a change — the click IS the approval, and denying is a first-class outcome',
  'app:changeRequest:cancel': 'owner withdraws a change request (owner-click teardown)',
  'app:bridge': 'the owner Bridge dispatch surface (audiences + spend-gate govern it per method)',
  'app:tools:test': 'owner diagnostic — executes an app tool as a test probe',
  'app:deps:approve': 'the owner approves (or re-approves) one app→app dependency edge — the click IS the approval',
  'app:deps:revoke': 'the owner revokes one app→app dependency edge (owner-click)',
  'app:deps:setMode': 'owner preference (app dependency enforcement: warn / enforce)',
  // Owner-only control planes.
  'app:settings:set': 'platform settings (owner preferences)',
  'app:spend:mode': 'spend policy — the leash on the AIs is never AI-writable',
  'app:spend:set': 'spend policy — the leash on the AIs is never AI-writable',
  'app:memory:runNow': 'idempotent maintenance trigger (owner diagnostic)',
  'app:media:refresh': 'idempotent refresh trigger (re-reads vendor model/voice lists; the daily review runs the same)',
  'app:media:sample': 'owner click — one metered TTS sample, generated once then cached',
  'app:git:commit': 'dev workflow (owner commits app changes)',
  'app:git:push': 'dev workflow (owner pushes app changes)',
  // Infra setup flows (DB provisioning, engine enablement) — one-time,
  // credential-adjacent, wizard-shaped.
  'app:extras:install': 'infra setup (apt/npm extras install)',
  'app:extras:unity:signIn': 'the owner\'s own Unity account sign-in (a URL only the owner approves)',
  'app:extras:unity:cancel': 'cancels the owner\'s Unity sign-in',
  'app:extras:unity:reactivate': 'owner click: re-activates the Unity licence (the hourly check does the same unattended)',
  'app:extras:unity:serial': 'owner-entered Unity Pro serial into the encrypted platform store',
  'app:setup:installDb': 'infra setup (MariaDB install)',
  'app:setup:setupUser': 'infra setup (DB user provisioning)',
  'app:db:connect': 'infra setup (DB credentials)',
  'app:db:disconnect': 'infra setup (DB teardown)',
  'app:setup:emailEngineEnable': 'infra setup (mail engine enable/disable)',
  'app:setup:emailEngineDepth': 'infra setup (sync depth)',
  'app:setup:emailEngineFolders': 'infra setup (folder selection)',
  // Changes outbound CONTENT, but only ever via a reply proposal the owner
  // approves — the signature is stitched at compose time and shown on the card
  // before anything is sent, so the owner click IS the approval.
  'app:setup:emailEngineSignature': 'owner preference (reply signature)',
  'app:setup:calendarSelect': 'infra setup (calendar selection)',
  'app:setup:calendarSyncNow': 'idempotent inward sync trigger (owner diagnostic)',
  'app:setup:aiConfig': 'AI-assisted config editor — owner reviews the actions it applies',
  // Diagnostics that send probes.
  'app:db:test': 'test probe (DB connection)',
  'app:translateKey:test': 'test probe (DeepL)',
  'app:mapsKey:test': 'test probe (Maps)',
  'app:braveKey:test': 'test probe (Brave)',
  'app:elevenlabsKey:test': 'test probe (ElevenLabs)',
  'app:setup:oauthTest': 'test probe (Google token)',
  'app:setup:emailTest': 'test probe (IMAP/SMTP login)',
  'app:setup:telegramTest': 'test probe (bot getMe/send)',
  'app:setup:telegramCheckDelivery': 'test probe (delivery check now; may make the webhook ⇄ poll switch the monitor makes on its own)',
  'app:setup:whatsappTest': 'test probe (Cloud API)',
  'app:setup:platformTelegramTest': 'test probe (control bot)',
  'app:setup:platformTelegramClaimCode': 'owner-click: mints the one-time claim code for the control bot (answered to that socket only)',
  'app:setup:connectivityCheck': 'test probe (connectivity sweep)',
  'app:status': 'status read with lazy idempotent DB auto-provision',
  'app:clientError': 'records a browser error from an app iframe in app-guard (inward log, no owner state)',
  // publish.js — peer management stays owner-click-only.
  'app:peer:remove': 'unlinks a slave (destructive pairing teardown, owner-click)',
  'app:peer:test': 'test probe (peer ping)',
  'app:peer:access': 'auth flow (asks a slave for a one-time dashboard login link)',
  'app:peer:trustOwnerClicks': 'the owner\'s trust flag for a slave\'s data-publish origin — owner-click on this dashboard only, deliberately no kind',
  'app:peer:kill': 'THE kill-switch — deliberately has no kind (05/06 doctrine)',
  'app:peer:slaveStart': 'auth flow (slave-side pairing request)',
  'app:peer:slaveReset': 'auth flow (slave-side pairing reset)',
  'app:peer:remoteSessions': 'the remote-session opt-in — owner-click on this host only, deliberately no kind',
  'app:print:save': 'printer settings (Setup → Drucker) — owner-click only; Horst does not print or configure printing (docs/print.md)',
  'app:print:test': 'the owner\'s test page button (Setup → Drucker) — owner-click only, a physical act; no kind (docs/print.md)',
  'app:fleet:data:cancel': 'cancel of a running app data publish — the app\'s own control (Horst lane never) and the owner\'s click on the peers panel; no kind',
};

const READONLY = new Set([
  'app:list', 'app:rename:preflight', 'app:logs', 'app:manifest', 'app:appmd',
  'app:getEmailAccounts', 'app:getAccessInfo', 'app:checkDomain', 'app:files', 'app:readFile', 'app:snapshots',
  'app:env', 'app:envSummary', 'app:setup:check', 'app:extras:status',
  'app:db:status', 'app:settings:get', 'app:models:get', 'app:translateKey:get',
  'app:mapsKey:get', 'app:braveKey:get', 'app:elevenlabsKey:get', 'app:memory:status',
  'app:tools:auditList', 'app:setup:overview', 'app:git:status',
  'app:changeRequests:list', 'app:media:catalog:get', 'app:deps:get',
  'app:spend:get', 'app:spend:overview', 'app:spend:host', 'app:grid:meta',
  'app:tasks:list', 'app:setup:oauthStatus', 'app:setup:emailList',
  'app:setup:emailEngineStatus', 'app:setup:calendarStatus',
  'app:setup:telegramStatus', 'app:setup:whatsappStatus',
  'app:setup:platformTelegramStatus', 'app:setup:cronList',
  'app:setup:cronHistory', 'app:print:get',
  // publish.js
  'app:peer:list', 'app:peer:keysPreview', 'app:peer:keysStatus',
  'app:peer:slaveStatus', 'app:publish:preflight', 'app:publish:toolchains', 'app:publish:status',
  'app:publish:history', 'app:publish:rollbackStatus', 'app:fleet:state', 'app:fleet:data:list',
]);

test('every dashboard WS mutation maps to a governed kind or the explicit allowlist', () => {
  const labels = [...caseLabels(read('index.js')), ...caseLabels(read('publish.js'))];
  assert.ok(labels.length > 100, `expected the WS surface, got ${labels.length} labels`);
  const kinds = { ...governance.KINDS, ...capabilities.horstKinds() };

  const unclassified = [];
  for (const label of labels) {
    const n = (label in GOVERNED ? 1 : 0) + (label in ALLOW ? 1 : 0) + (READONLY.has(label) ? 1 : 0);
    if (n === 0) unclassified.push(label);
    assert.ok(n <= 1, `"${label}" is classified more than once`);
  }
  assert.deepEqual(unclassified, [], 'new WS handlers must be classified in horst-completeness.test.js (kind, allowlist or read-only)');

  // No stale classifications — the maps must not outlive their handlers.
  const live = new Set(labels);
  for (const label of [...Object.keys(GOVERNED), ...Object.keys(ALLOW), ...READONLY]) {
    assert.ok(live.has(label), `classified "${label}" no longer exists in index.js/publish.js`);
  }

  // Every referenced kind is actually registered.
  for (const [label, kind] of Object.entries(GOVERNED)) {
    assert.ok(kinds[kind], `"${label}" maps to kind "${kind}", which is not in the registry`);
  }
});

test('G8: lockout-risk, destructive and outward-facing kinds are ceiling-pinned to propose', () => {
  const kinds = capabilities.horstKinds();
  const pinned = [
    'server.restart', 'peer.restart', // lockout-risk (G8)
    'app.create', 'app.delete', 'app.rename', 'app.setConfig', // platform/perimeter changes
    'app.publish', 'app.rollback', 'peer.keys.sync', 'peer.session.launch', // fleet (5D)
    'telegram.send', 'whatsapp.send', 'email.send', 'calendar.invite', // outward-facing
    'cron.set', 'email.rule.add', // unattended-config / visibility-destroying
    'config.set', // reshapes how Horst reads the world from then on; no undo executor
    'ai.setDefault', // which model runs, and what it costs, is the owner's choice
  ];
  for (const k of pinned) {
    assert.ok(kinds[k], `pinned kind "${k}" is not registered`);
    assert.equal(kinds[k].ceiling, 'propose', `"${k}" must be ceiling-pinned to propose`);
    assert.equal(kinds[k].defaultLevel, 'propose', `"${k}" must default to propose`);
  }
  // The kill-switch has NO kind at all — owner-click only.
  assert.ok(!kinds['peer.kill'] && !governance.KINDS['peer.kill'], 'peer.kill must never be a governed kind');
});

test('an autonomous DEFAULT is only ever granted to a reversible or idempotent kind', () => {
  // capabilities-check rule 21 as a runtime assertion. A ceiling is a
  // capability the owner may grant; a DEFAULT is a decision made on behalf of
  // everyone who never opened the dials, so it may only ever make mistakes the
  // world can absorb.
  const kinds = capabilities.horstKinds();
  for (const [k, d] of Object.entries(kinds)) {
    if (!String(d.defaultLevel || '').startsWith('auto')) continue;
    assert.ok(d.undo || d.idempotent,
      `"${k}" defaults to "${d.defaultLevel}" but declares neither undo nor idempotent`);
  }
});

test('remediation kinds pair the failure senses and default to auto+notify', () => {
  const kinds = capabilities.horstKinds();
  const senses = new Set(capabilities.horstSenses().map((s) => s.key));
  const pairs = [
    ['cron:failed', 'cron.retry'],
    ['job:failed', 'job.retry'],
    ['spawn:failed', 'spawn.restart'],
    ['email:sync:failed', 'email.sync.reconnect'],
  ];
  for (const [sense, kind] of pairs) {
    assert.ok(senses.has(sense), `sense "${sense}" missing`);
    assert.ok(kinds[kind], `remediation kind "${kind}" missing`);
    assert.equal(kinds[kind].ceiling, 'auto+notify', `"${kind}" ceiling`);
    // These four repair something that broke on its own. Waiting for an
    // approval to reconnect a dropped mailbox costs more than the repair does,
    // so they run at their ceiling by default — each one reversible or
    // idempotent, which is what earns the promotion (rule 21).
    assert.equal(kinds[kind].defaultLevel, 'auto+notify', `"${kind}" must now default to auto+notify`);
    assert.ok(kinds[kind].idempotent || kinds[kind].undo, `"${kind}" runs unattended and must declare undo or idempotent`);
  }
  // The triage rules binding sense → retry proposal exist (run-action path).
  const horstSrc = read('platform-horst.js');
  for (const rule of ["'cron:failed': 'cron-retry'", "'job:failed': 'job-retry'", "'email:sync:failed': 'mail-reconnect'"]) {
    assert.ok(horstSrc.includes(rule), `platform-horst RUN_ACTION_KINDS missing ${rule}`);
  }
});

test('lifecycle kinds and WS handlers share one implementation (app-lifecycle.js)', () => {
  const lifecycle = read('app-lifecycle.js');
  const indexSrc = read('index.js');
  const appsCap = read(path.join('capabilities', 'apps.js'));
  for (const fn of ['createApp', 'deleteApp', 'renameApp', 'setAppConfig']) {
    assert.ok(lifecycle.includes(`function ${fn}`), `app-lifecycle.js must implement ${fn}`);
    assert.ok(indexSrc.includes(`appLifecycle.${fn}(`), `index.js WS handler must call appLifecycle.${fn}`);
    assert.ok(appsCap.includes(`.${fn}(`), `capabilities/apps.js kind must execute through app-lifecycle.${fn}`);
  }
  // The old inline implementations are gone from index.js.
  assert.ok(!indexSrc.includes('appManager.create(msg.name'), 'app:create must go through app-lifecycle');
  assert.ok(!indexSrc.includes('appManager.rename(msg.name'), 'app:rename must go through app-lifecycle');
});
