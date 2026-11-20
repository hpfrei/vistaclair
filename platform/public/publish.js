// === Publish-to-Slave Module (Pro) ===
// Master side: the multi-step "Publish app" wizard (peer pick → preflight/
// commit → toolchains → live progress → result), the Setup → Remote pane
// (linked slaves, pending pairing requests) and the per-slave "Sync keys"
// dialog (provider API keys + model registry), and per slave the Remote
// sessions section with its launch dialog (views in remote-sessions-view.js).
// Slave side: the Slave-mode pairing card in Setup → Remote (with the remote
// sessions opt-in, the only control there) and a persistent "SLAVE" badge.
//
// Server surface: app:peer:* / app:publish:* WS messages (vistaclair-pro/
// src/apps/publish.js). The publish itself is a persistent server job — while
// the wizard is open it polls app:publish:status once a second, so a page
// reload can reattach at any time.
(function() {
  'use strict';
  const { sendWs, escHtml, registerModule, showConfirm } = window.dashboard;

  const peerState = {
    role: 'master',
    slave: null,
    enabledApps: null,
    hasToken: false,
    remoteSessions: { enabled: false, allowApiKey: false },   // this slave's opt-in
    peers: [],
    requests: [],
    testResults: {},   // peer name → last app:peer:testResult (survives pane re-renders)
    lastAutoTest: {},  // peer name → ts of last automatic test
    keysSync: {},      // peer name → server-side key-sync state (survives GUI reloads)
    fleet: [],         // app:fleet:state peers — live channel state per slave
    dataTransfers: [], // app:fleet:data:list — the master's data publishes (fleet-data.js)
    dataErrors: {},    // transfer id → last refused cancel
    // Remote sessions (master): app:peer:sessions:state peers, plus the last
    // alert (from the state, or a live remoteAlert) / notice / refusal per peer.
    rs: { peers: [], alerts: {}, notices: {}, errors: {} },
  };
  const rsView = window.remoteSessionsView;

  // Open-UI callbacks (single wizard / single pane at a time)
  let onPreflight = null;
  let onStarted = null;
  let onStatus = null;
  let onTestResult = null;
  let onToolchains = null;
  let onSlaveResult = null;
  let onAccessResult = null;
  let onOpResult = null;
  let onKeysPreview = null;
  let onKeysResult = null;
  let onHistory = null;
  let onRollbackStarted = null;
  let onRollbackStatus = null;
  let onLaunchResult = null;
  const rsKills = new Map();   // kill reqId → peer name
  let rsSeq = 0;
  let rsDismissPeer = null;    // peer of the pending app:peer:remoteAlert:dismiss

  function fmtBytes(n) {
    if (n == null) return '';
    if (n > 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    if (n > 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  // --- Slave software-version display (from app:peer:testResult.versions) ---

  function versionsCurrent(v) {
    return !!v && v.vc?.status === 'current' && v.vcPro?.status === 'current';
  }

  function fmtVersions(v) {
    if (!v) return '';
    const one = (label, r) => {
      if (!r || r.status === 'unknown') return `${label} ?`;
      if (r.status === 'current') return `${label} ✓`;
      if (r.status === 'behind') return `${label} ${r.behind != null ? r.behind + ' behind' : 'outdated'}`;
      return `${label} ahead of master`;
    };
    return `${one('vc', v.vc)} · ${one('vc-pro', v.vcPro)}`;
  }

  // Label + css class for a cached/incoming test result.
  function testResultView(m) {
    if (!m) return null;
    if (!m.ok) return { text: m.error || 'unreachable', cls: 'bad' };
    if (!m.versions) return { text: 'reachable', cls: 'ok' };
    return versionsCurrent(m.versions)
      ? { text: `reachable · ${fmtVersions(m.versions)}`, cls: 'ok' }
      : { text: `reachable · ${fmtVersions(m.versions)}`, cls: 'warn' };
  }

  // --- Key-sync display (server state + the peer record's persisted outcome) ---

  function fmtAgo(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return 'on ' + new Date(ts).toLocaleDateString();
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function fmtApplied(a) {
    if (!a) return '';
    const bits = [];
    if (a.providerKeys) bits.push(plural(a.providerKeys, 'provider key'));
    if (a.modelKeys) bits.push(plural(a.modelKeys, 'model key'));
    if (a.models) bits.push(plural(a.models, 'model'));
    return (bits.join(', ') || 'nothing') + (a.replaced ? ' · mirrored' : '');
  }

  // Live server state wins; otherwise fall back to what the peer record kept,
  // so the line survives a GUI reload.
  function keysSyncView(p) {
    const live = peerState.keysSync[p.name];
    if (live?.status === 'running') return { text: 'syncing keys…', cls: '' };
    if (live?.status === 'error') return { text: `key sync failed: ${live.error || 'unknown error'}`, cls: 'bad' };
    if (live?.status === 'ok') return { text: `keys synced ${fmtAgo(live.finishedAt)} · ${fmtApplied(live.applied)}`, cls: 'ok' };
    if (p.keysSyncedAt) return { text: `keys synced ${fmtAgo(p.keysSyncedAt)} · ${fmtApplied(p.keysSyncedSummary)}`, cls: 'ok' };
    if (p.keysSyncError) return { text: `key sync failed: ${p.keysSyncError}`, cls: 'bad' };
    return { text: 'API keys not synced to this slave yet', cls: '' };
  }

  registerModule('app:peer:', (msg) => {
    switch (msg.type) {
      case 'app:peer:slaveStatus':
        peerState.role = msg.role || 'master';
        peerState.slave = msg.slave || null;
        peerState.enabledApps = msg.enabledApps || null;
        peerState.hasToken = !!msg.hasToken;
        peerState.remoteSessions = msg.remoteSessions || { enabled: false, allowApiKey: false };
        updateSlaveBadge();
        renderRemotePaneIfOpen();
        break;
      case 'app:peer:list':
        peerState.peers = msg.peers || [];
        window.appsModule?.patchRemoteChips?.();
        peerState.requests = msg.requests || [];
        renderRemotePaneIfOpen();
        break;
      case 'app:peer:testResult':
        peerState.testResults[msg.id] = msg;
        onTestResult?.(msg);
        break;
      case 'app:peer:accessResult':
        onAccessResult?.(msg);
        break;
      case 'app:peer:opResult':
        onOpResult?.(msg);
        break;
      case 'app:peer:slaveStartResult':
        onSlaveResult?.(msg);
        break;
      // Key sync. keysStatus is the server's own view — it arrives on connect
      // and on every transition, so a reload mid-sync still shows "syncing…".
      case 'app:peer:keysStatus':
        peerState.keysSync = msg.peers || {};
        renderRemotePaneIfOpen();
        break;
      case 'app:peer:keysPreviewResult':
        onKeysPreview?.(msg);
        break;
      case 'app:peer:keysResult':
        onKeysResult?.(msg);
        break;
      // Remote sessions (peer-remote-master.js). Every slave string is text.
      case 'app:peer:sessions:state':
        peerState.rs.peers = Array.isArray(msg.peers) ? msg.peers : [];
        // The server keeps each peer's last alert: its view replaces ours
        // (a dismissed or cleared alert comes back as null).
        peerState.rs.alerts = rsView.alertsFromState(peerState.rs.peers);
        renderRsSections();
        break;
      case 'app:peer:remoteAlert':
        if (typeof msg.peer !== 'string') break;
        peerState.rs.alerts[msg.peer] = { problem: msg.problem, text: msg.text, at: Date.now() };
        renderRsSections();
        break;
      case 'app:peer:remoteAlert:dismissResult':
      {
        // A refusal names no peer: it is the one last dismissed.
        const peer = typeof msg.peer === 'string' ? msg.peer : rsDismissPeer;
        rsDismissPeer = null;
        if (!msg.ok && peer) { peerState.rs.errors[peer] = rsView.errorText(msg.code, peer, msg.error); renderRsSections(); }
        break;
      }
      case 'app:peer:session:notice':
        if (typeof msg.peer !== 'string') break;
        peerState.rs.notices[msg.peer] = { level: msg.level, text: msg.text };
        renderRsSections();
        break;
      case 'app:peer:session:launchResult':
        onLaunchResult?.(msg);
        break;
      case 'app:peer:session:joinRunsResult':
        // The sessions-state broadcast that follows re-renders the switch; a
        // refusal shows on the slave's row (and the switch snaps back).
        if (!msg.ok && typeof msg.peer === 'string') {
          peerState.rs.errors[msg.peer] = rsView.errorText(msg.code, msg.peer, msg.error);
          renderRsSections();
        }
        break;
      case 'app:peer:session:killResult':
      {
        // The failure shape carries no tabId: the reqId names the peer.
        const peer = rsKills.get(msg.reqId);
        rsKills.delete(msg.reqId);
        if (peer && !msg.ok) { peerState.rs.errors[peer] = rsView.errorText(msg.code, peer, msg.error); renderRsSections(); }
        break;
      }
    }
  });

  registerModule('app:publish:', (msg) => {
    switch (msg.type) {
      case 'app:publish:preflight': onPreflight?.(msg); break;
      case 'app:publish:toolchains': onToolchains?.(msg); break;
      case 'app:publish:started': onStarted?.(msg); break;
      case 'app:publish:status': onStatus?.(msg); break;
      case 'app:publish:history': onHistory?.(msg); break;
      case 'app:publish:rollbackStarted': onRollbackStarted?.(msg); break;
      case 'app:publish:rollbackStatus': onRollbackStatus?.(msg); break;
    }
  });

  // Live fleet view (peer channel): connected/lastSeen/per-app health per
  // slave. Broadcast on every transition; also sent on connect and on request.
  registerModule('app:fleet:', (msg) => {
    if (msg.type === 'app:fleet:state') {
      peerState.fleet = msg.peers || [];
      renderRemotePaneIfOpen();
      window.appsModule?.patchRemoteChips?.();
    } else if (msg.type === 'app:fleet:data:list') {
      // The server's persisted records: on connect, on request and after every
      // finished transfer — a reload reattaches from here.
      peerState.dataTransfers = Array.isArray(msg.transfers) ? msg.transfers : [];
      renderAllDataBoxes();
    } else if (msg.type === 'app:fleet:data:progress') {
      const t = msg.transfer;
      if (!t || typeof t.id !== 'string') return;
      const i = peerState.dataTransfers.findIndex((x) => x.id === t.id);
      if (i >= 0) peerState.dataTransfers[i] = { ...peerState.dataTransfers[i], ...t };
      else peerState.dataTransfers.unshift(t);
      renderDataBox(t.peer);
    } else if (msg.type === 'app:fleet:data:cancelResult') {
      if (!msg.ok && typeof msg.id === 'string') {
        peerState.dataErrors[msg.id] = msg.error || 'cancel failed';
        renderAllDataBoxes();
      }
    }
  });

  // --- Slave badge (persistent, unobtrusive) --------------------------------

  function updateSlaveBadge() {
    document.querySelector('body > header')?.classList.toggle('slave-role-header', peerState.role === 'slave');
    let badge = document.getElementById('slaveModeBadge');
    if (peerState.role !== 'slave') { badge?.remove(); return; }
    const linked = peerState.slave?.linkStatus === 'linked';
    const label = `SLAVE${peerState.slave?.name ? ' · ' + escHtml(peerState.slave.name) : ''}${linked ? '' : ' · not linked'}`;
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'slaveModeBadge';
      badge.className = 'slave-mode-badge';
      badge.title = 'This instance is a slave: apps published from the master are read-only mirrors here. Locally created apps are unaffected.';
      document.body.appendChild(badge);
    }
    badge.innerHTML = `<span class="slave-mode-dot${linked ? ' linked' : ''}"></span>${label}`;
  }

  // --- Publish wizard -------------------------------------------------------

  // Standalone it is its own modal; with `{ mount, onExit }` it renders into
  // `mount` (the Remote tab of the app settings modal) and Close / Cancel /
  // Hide call `onExit` instead of removing a backdrop. Returns the closer.
  function embedHost(opts) {
    if (opts && opts.mount) {
      const modal = opts.mount;
      modal.classList.add('publish-embed');
      return { modal, remove: () => { modal.innerHTML = ''; opts.onExit?.(); } };
    }
    document.querySelector('.publish-modal-backdrop')?.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'alert-modal-backdrop publish-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'alert-modal publish-modal';
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    return { modal, backdrop, remove: () => backdrop.remove() };
  }

  function wireStandaloneClose(host, close) {
    if (!host.backdrop) return;
    host.backdrop.addEventListener('click', (e) => { if (e.target === host.backdrop) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
  }

  // One line per extra the toolchains step covers, plus the owner actions the
  // slave reports (the Unity licence is per machine).
  function toolchainPlanHtml(m) {
    if (m.error) return `<span class="publish-git bad">${escHtml(m.error)}</span>`;
    const verb = { present: 'present', install: 'will install', installing: 'installing on the slave', unknown: 'unknown to the slave — update vistaclair-pro there' };
    const rows = (m.rows || []).map((r) => {
      const cls = r.state === 'present' ? 'clean' : r.state === 'unknown' ? 'bad' : 'ahead';
      const extra = r.state === 'install' ? ` (${escHtml(r.size || '')})${r.sudoOk ? '' : ' — the slave lacks passwordless sudo, the install will fail'}${r.lastError ? ` — last attempt: ${escHtml(r.lastError)}` : ''}`
        : r.state === 'installing' ? ` (${r.progress}% · ${escHtml(r.label || '')})` : '';
      return `<div class="publish-git ${cls}">${escHtml(r.id)} — ${verb[r.state] || escHtml(r.state)}${extra}</div>`;
    });
    for (const k of m.unknown || []) rows.push(`<div class="publish-git warn">${escHtml(k)} — unknown toolchain, ignored</div>`);
    const fix = m.setupUrl ? ` <a href="${escHtml(m.setupUrl)}" target="_blank" rel="noopener">open ${escHtml(m.peer)} → Setup → Extras</a>` : '';
    for (const a of m.actions || []) rows.push(`<div class="publish-git warn">&#9888; ${escHtml(m.peer)}: ${escHtml(a.action)}${fix}</div>`);
    return rows.join('') || '<span class="publish-git clean">nothing to install</span>';
  }

  function showPublish(appName, opts) {
    const host = embedHost(opts);
    const modal = host.modal;
    const embedded = !host.backdrop;

    let pollTimer = null;
    let pre = null; // preflight payload
    const close = () => {
      if (pollTimer) clearInterval(pollTimer);
      onPreflight = onStarted = onStatus = onTestResult = onToolchains = null;
      host.remove();
    };
    wireStandaloneClose(host, close);

    const header = (sub) => `
      <div class="publish-head">
        <div>
          <div class="publish-title">Publish <strong>${escHtml(appName)}</strong></div>
          <div class="publish-sub">${sub}</div>
        </div>
        <button class="publish-x" aria-label="Close"${embedded ? ' title="Back to the remote state"' : ''}>${embedded ? '&larr;' : '&times;'}</button>
      </div>`;
    const wireClose = () => modal.querySelector('.publish-x')?.addEventListener('click', close);

    function renderLoading() {
      modal.innerHTML = header('Checking app and linked slaves…') + '<div class="publish-body"><div class="publish-loading">Loading…</div></div>';
      wireClose();
    }

    function renderNoPeers() {
      modal.innerHTML = header('No slave linked yet') + `
        <div class="publish-body">
          <p>Publishing deploys this app to a linked slave server: the slave receives the app's committed code as a bundle, installs dependencies and restarts it there. App data is never part of it — an app that copies data to a slave does so from its own UI (data publish).</p>
          <p>No slave is linked to this master yet. To link one:</p>
          <ol class="publish-steps-hint">
            <li>Install vistaclair + pro on the remote server.</li>
            <li>There, open <strong>Setup &rarr; Remote</strong>, enable <strong>Slave mode</strong> and enter this master's URL.</li>
            <li>Approve the pairing request here (Horst approvals or Telegram).</li>
          </ol>
          <div class="publish-actions"><button class="setup-btn" data-act="close">Close</button></div>
        </div>`;
      wireClose();
      modal.querySelector('[data-act="close"]').addEventListener('click', close);
    }

    function renderForm() {
      const git = pre.git || {};
      const peerOpts = pre.peers.map((p) => `<option value="${escHtml(p.name)}">${escHtml(p.name)} — ${escHtml(p.baseUrl)}</option>`).join('');
      const gitLine = !git
        ? '<span class="publish-git bad">not a git repository</span>'
        : git.dirty
          ? `<span class="publish-git dirty">Uncommitted changes (${(git.modified || 0) + (git.staged || 0)} modified, ${git.untracked || 0} new)</span>`
          : git.ahead > 0
            ? `<span class="publish-git ahead">Committed, ${git.ahead} commit(s) will be pushed</span>`
            : '<span class="publish-git clean">Committed &amp; pushed</span>';

      modal.innerHTML = header('Deploy committed code to a slave') + `
        <div class="publish-body">
          <div class="publish-section">
            <div class="publish-section-title">1 &middot; Target</div>
            <select id="publishPeer" class="publish-select">${peerOpts}</select>
            <span id="publishPeerTest" class="publish-peer-test"></span>
          </div>
          <div class="publish-section">
            <div class="publish-section-title">2 &middot; Code</div>
            <div class="publish-git-row">${gitLine}</div>
            ${git?.dirty ? `<input id="publishCommitMsg" class="publish-input" type="text" value="${escHtml(pre.suggestedCommitMessage || '')}" placeholder="Commit message — only this app's files are committed">` : ''}
          </div>
          ${pre.toolchains?.length ? `
          <div class="publish-section">
            <div class="publish-section-title">Toolchains <span class="publish-section-note">platform extras this app declares; missing ones are installed on the slave</span></div>
            <div id="publishToolchains" class="publish-toolchains">checking the slave…</div>
          </div>` : ''}
          <div class="publish-hint">Only the app's committed code travels: its <code>.data/</code>, database, settings and secrets stay on each host. Platform provider API keys have their own <strong>Sync keys</strong> action in Setup &rarr; Remote.</div>
          <div class="publish-actions">
            <button class="setup-btn" data-act="cancel">Cancel</button>
            <button class="setup-btn setup-btn-primary" data-act="publish">Publish</button>
          </div>
        </div>`;
      wireClose();
      modal.querySelector('[data-act="cancel"]').addEventListener('click', close);

      const peerSel = modal.querySelector('#publishPeer');
      const testEl = modal.querySelector('#publishPeerTest');
      const testPeer = () => {
        testEl.textContent = 'checking…';
        testEl.className = 'publish-peer-test';
        onTestResult = (m) => {
          if (m.id !== peerSel.value) return;
          if (!m.ok) {
            testEl.textContent = `unreachable: ${m.error}`;
            testEl.className = 'publish-peer-test bad';
            return;
          }
          const dep = m.ping?.deployed?.[appName];
          let text = dep ? `reachable · has ${dep.slice(0, 8)}` : 'reachable · app not deployed yet';
          let cls = 'ok';
          if (m.versions && !versionsCurrent(m.versions)) {
            text += ` · slave software: ${fmtVersions(m.versions)}`;
            cls = 'warn';
          }
          testEl.textContent = text;
          testEl.className = 'publish-peer-test ' + cls;
        };
        sendWs({ type: 'app:peer:test', id: peerSel.value });
      };
      peerSel.addEventListener('change', testPeer);
      testPeer();

      // What the toolchains step will do on the chosen slave (app:publish:toolchains).
      const tcEl = modal.querySelector('#publishToolchains');
      const loadToolchains = () => {
        if (!tcEl) return;
        tcEl.textContent = 'checking the slave…';
        onToolchains = (m) => {
          if (m.appName !== appName || m.peer !== peerSel.value) return;
          tcEl.innerHTML = toolchainPlanHtml(m);
        };
        sendWs({ type: 'app:publish:toolchains', name: appName, peer: peerSel.value });
      };
      peerSel.addEventListener('change', loadToolchains);
      loadToolchains();

      modal.querySelector('[data-act="publish"]').addEventListener('click', () => {
        // Blank is fine — the server falls back to its generated message.
        const commitMessage = modal.querySelector('#publishCommitMsg')?.value?.trim() || '';
        onStarted = (m) => {
          if (m.error) {
            renderForm();
            const body = modal.querySelector('.publish-body');
            body.insertAdjacentHTML('afterbegin', `<div class="publish-error">${escHtml(m.error)}</div>`);
            return;
          }
          startPolling();
        };
        sendWs({ type: 'app:publish:start', name: appName, peer: peerSel.value, commitMessage });
        renderProgress(null);
      });
    }

    function stepIcon(status) {
      if (status === 'done') return '<span class="publish-step-ico ok">&#10003;</span>';
      if (status === 'warn') return '<span class="publish-step-ico warn">!</span>';
      if (status === 'running') return '<span class="publish-step-ico spin"></span>';
      if (status === 'failed') return '<span class="publish-step-ico bad">&#10007;</span>';
      return '<span class="publish-step-ico pend"></span>';
    }

    function renderProgress(job) {
      const steps = job?.meta?.steps || [];
      const running = job?.status === 'running';
      const done = job?.status === 'done';
      const failed = job && !running && !done;
      const pct = job?.progress?.pct ?? 0;
      const label = job?.progress?.label || (job ? job.status : 'Starting…');

      modal.innerHTML = header(job?.meta?.peer ? `to <strong>${escHtml(job.meta.peer)}</strong>` : 'Starting…') + `
        <div class="publish-body">
          <div class="publish-progress-bar"><div class="publish-progress-fill${failed ? ' bad' : ''}" style="width:${done ? 100 : pct}%"></div></div>
          <div class="publish-progress-label">${escHtml(label || '')}</div>
          <div class="publish-steplist">
            ${steps.map((s) => `
              <div class="publish-step ${s.status}">
                ${stepIcon(s.status)}
                <span class="publish-step-label">${escHtml(s.label)}</span>
                <span class="publish-step-detail">${escHtml(s.detail || '')}</span>
              </div>`).join('')}
          </div>
          ${done ? `
            ${job.result?.warnings?.length ? `<div class="publish-result warn">Needs you on ${escHtml(job.meta.peer)}:<ul>${job.result.warnings.map((w) => `<li>${escHtml(w)}</li>`).join('')}</ul></div>` : ''}
            <div class="publish-result ok">Published. <a href="${escHtml(job.result?.appUrl || '#')}" target="_blank" rel="noopener">Open ${escHtml(appName)} on ${escHtml(job.meta.peer)}</a></div>
            <div class="publish-hint">If the app needs secrets (Telegram bot, email sender, API keys), configure them on the slave's own Setup page.</div>` : ''}
          ${failed ? `<div class="publish-result bad">${escHtml(job.error || 'Publish ' + job.status)}</div>` : ''}
          <div class="publish-actions">
            ${running ? '<button class="setup-btn setup-btn-danger" data-act="cancel-job">Cancel publish</button>' : ''}
            ${failed ? '<button class="setup-btn" data-act="retry">Back</button>' : ''}
            <button class="setup-btn" data-act="close">${running ? 'Hide (keeps running)' : 'Close'}</button>
          </div>
        </div>`;
      wireClose();
      modal.querySelector('[data-act="close"]').addEventListener('click', close);
      modal.querySelector('[data-act="cancel-job"]')?.addEventListener('click', () => {
        sendWs({ type: 'app:publish:cancel', name: appName });
      });
      modal.querySelector('[data-act="retry"]')?.addEventListener('click', () => {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        renderLoading();
        sendWs({ type: 'app:publish:preflight', name: appName });
      });
    }

    function startPolling() {
      if (pollTimer) clearInterval(pollTimer);
      onStatus = (m) => {
        if (m.appName !== appName || !m.job) return;
        renderProgress(m.job);
        if (m.job.status !== 'running' && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      };
      pollTimer = setInterval(() => sendWs({ type: 'app:publish:status', name: appName }), 1000);
      sendWs({ type: 'app:publish:status', name: appName });
    }

    renderLoading();
    onPreflight = (m) => {
      if (m.error) {
        modal.querySelector('.publish-body').innerHTML = `<div class="publish-error">${escHtml(m.error)}</div>`;
        return;
      }
      pre = m;
      peerState.peers = m.peers || peerState.peers;
      if (m.running) { renderProgress(m.running); startPolling(); return; }
      if (!m.peers?.length) { renderNoPeers(); return; }
      renderForm();
    };
    sendWs({ type: 'app:publish:preflight', name: appName });
    return close;
  }

  // --- Sync keys to a slave -------------------------------------------------
  // Sends this master's provider API keys, per-model key overrides and model
  // registry to one slave over the peer channel. Real credentials cross the
  // wire, so the dialog states that plainly and mirroring is opt-in.

  function showKeySync(peerName) {
    document.querySelector('.publish-modal-backdrop')?.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'alert-modal-backdrop publish-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'alert-modal publish-modal';
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = () => {
      onKeysPreview = onKeysResult = null;
      backdrop.remove();
    };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });

    const peer = peerState.peers.find((p) => p.name === peerName);
    const head = `
      <div class="publish-head">
        <div>
          <div class="publish-title">Sync keys to <strong>${escHtml(peerName)}</strong></div>
          <div class="publish-sub">${escHtml(peer?.baseUrl || '')}</div>
        </div>
        <button class="publish-x" aria-label="Close">&times;</button>
      </div>`;
    const wireClose = () => modal.querySelector('.publish-x')?.addEventListener('click', close);

    modal.innerHTML = head + '<div class="publish-body"><div class="publish-loading">Reading this master\'s key store…</div></div>';
    wireClose();

    onKeysPreview = (m) => {
      if (!m.ok) {
        modal.querySelector('.publish-body').innerHTML = `<div class="publish-error">${escHtml(m.error)}</div>`;
        return;
      }
      const pv = m.preview;
      const providerList = pv.providers.length ? pv.providers.join(', ') : 'none';
      modal.innerHTML = head + `
        <div class="publish-body">
          <div class="publish-section">
            <div class="publish-section-title">What is sent</div>
            <div class="publish-data-row"><span class="publish-data-label">Provider API keys</span><span class="publish-data-size">${escHtml(providerList)}</span></div>
            <div class="publish-data-row"><span class="publish-data-label">Per-model key overrides</span><span class="publish-data-size">${pv.modelKeys || 'none'}</span></div>
            <div class="publish-data-row"><span class="publish-data-label">Model registry</span><span class="publish-data-size">${plural(pv.models, 'model')}, ${plural(pv.providerDefs, 'provider')}</span></div>
            <div class="publish-warn">Real API keys are transmitted to this slave and stored in its encrypted key store. Anyone with access to that server can spend against them.</div>
          </div>
          <div class="publish-section">
            <div class="publish-section-title">How the slave applies them</div>
            <label class="publish-radio-row">
              <input type="radio" name="keysMode" value="merge" checked>
              <span>Merge
                <span class="publish-radio-note">Overwrites keys and models with the same name. Anything configured only on the slave is left alone.</span>
              </span>
            </label>
            <label class="publish-radio-row">
              <input type="radio" name="keysMode" value="replace">
              <span>Mirror exactly
                <span class="publish-radio-note">The slave ends up with exactly this master's keys and models — keys and models that exist only on the slave are deleted there.</span>
              </span>
            </label>
          </div>
          <div id="keysSyncStatus" class="setup-status"></div>
          <div class="publish-actions">
            <button class="setup-btn" data-act="cancel">Cancel</button>
            <button class="setup-btn setup-btn-primary" data-act="sync">Sync keys</button>
          </div>
        </div>`;
      wireClose();
      modal.querySelector('[data-act="cancel"]').addEventListener('click', close);

      const statusEl = modal.querySelector('#keysSyncStatus');
      const syncBtn = modal.querySelector('[data-act="sync"]');
      syncBtn.addEventListener('click', async () => {
        const replace = modal.querySelector('input[name="keysMode"]:checked')?.value === 'replace';
        if (replace && !(await showConfirm(`Mirror exactly to "${peerName}"?\n\nAPI keys and models that exist only on that slave will be DELETED there.`, { confirmLabel: 'Mirror', danger: true }))) return;
        syncBtn.disabled = true;
        statusEl.innerHTML = '<span class="setup-check loading">Sending…</span>';
        // The sync also lives server-side: closing this dialog (or reloading)
        // does not lose it — the slave row keeps showing its state.
        onKeysResult = (m) => {
          if (m.ok) { close(); return; }
          syncBtn.disabled = false;
          statusEl.innerHTML = `<span class="setup-check fail">${escHtml(m.error || 'sync failed')}</span>`;
        };
        sendWs({ type: 'app:peer:syncKeys', id: peerName, replace });
      });
    };
    sendWs({ type: 'app:peer:keysPreview', id: peerName });
  }

  // --- Fleet view (peer channel; per-peer live state + history/rollback) ----

  function fleetFor(name) { return peerState.fleet.find((f) => f.name === name) || null; }

  function fleetLines(p) {
    const f = fleetFor(p.name);
    if (!f) return '';
    const seen = f.connected ? 'live channel' : (f.lastSeen ? `channel down · last seen ${fmtAgo(f.lastSeen)}` : 'channel not connected');
    const apps = Object.keys(f.appHealth || {}).sort();
    const appRows = apps.map((a) => {
      const health = f.appHealth[a] || 'unknown';
      const dep = f.deployed?.[a];
      const commit = typeof dep === 'string' ? dep : dep?.commit;
      const behind = (dep && typeof dep === 'object') ? dep.behind : null;
      const job = f.lastJobs?.[a];
      return `
        <div class="peer-fleet-app">
          <span class="peer-fleet-health ${health === 'ok' ? 'ok' : 'bad'}" title="health: ${escHtml(health)}"></span>
          <span class="peer-fleet-name">${escHtml(a)}</span>
          <span class="peer-fleet-commit">${commit ? escHtml(String(commit).slice(0, 8)) : '—'}${behind ? ` <span class="peer-fleet-outdated" title="${behind} commit(s) touching this app landed on the master since this deploy">${behind} behind</span>` : ''}</span>
          ${job && job.status !== 'done' ? `<span class="peer-fleet-job">${escHtml(job.name)}: ${escHtml(job.status)}${job.error ? ' — ' + escHtml(job.error) : ''}</span>` : ''}
          <button class="setup-btn" data-act="history" data-peer="${escHtml(p.name)}" data-app="${escHtml(a)}" title="Publish history on this slave — roll back to a kept version">History</button>
        </div>`;
    }).join('');
    return `
      <div class="peer-fleet-line ${f.connected ? 'ok' : ''}"><span class="peer-fleet-dot${f.connected ? ' live' : ''}"></span>${escHtml(seen)}</div>
      ${appRows ? `<div class="peer-fleet-apps">${appRows}</div>` : ''}`;
  }

  // --- Data publishes per slave (fleet-data.js) -----------------------------
  // The app starts them from its own UI; here the owner watches them and can
  // cancel a running one. Running ones first, then the newest finished ones.
  // Both directions: ↓ this master → the slave, ↑ the slave → this master.
  const DATA_DONE_SHOWN = 5;

  function dataTransfersFor(peerName) {
    const mine = peerState.dataTransfers.filter((t) => t.peer === peerName);
    const running = mine.filter((t) => t.status === 'running');
    const ended = mine.filter((t) => t.status !== 'running')
      .sort((a, b) => (b.finishedAt || b.updatedAt || 0) - (a.finishedAt || a.updatedAt || 0))
      .slice(0, DATA_DONE_SHOWN);
    return [...running, ...ended];
  }

  function dataResultText(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v).slice(0, 300); } catch { return ''; }
  }

  function dataRowHtml(t) {
    const running = t.status === 'running';
    const cls = running ? 'running' : t.status === 'done' ? 'ok' : t.status === 'cancelled' ? 'dim' : 'bad';
    const need = t.needBytes;
    const pct = t.status === 'done' ? 100 : need ? Math.min(100, Math.round(((t.sentBytes || 0) / need) * 100)) : 0;
    const bytes = need != null ? `${fmtBytes(t.sentBytes || 0) || '0 KB'} / ${fmtBytes(need) || '0 KB'}` : '';
    const blobs = t.blobsNeed != null ? ` · ${t.blobsDone || 0}/${t.blobsNeed} blobs` : '';
    const result = running ? (t.label || '') : t.status === 'done' ? dataResultText(t.summary) : (t.error || dataResultText(t.summary) || t.status);
    const refused = peerState.dataErrors[t.id];
    return `
      <div class="peer-fd-row ${cls}" data-fd-id="${escHtml(t.id)}" data-fd-dir="${t.dir === 'up' ? 'up' : 'down'}">
        <span class="peer-fd-dir" title="${t.dir === 'up' ? 'up: from this slave to the master' : 'down: from the master to this slave'}">${t.dir === 'up' ? '↑' : '↓'}</span>
        <span class="peer-fd-app"><strong>${escHtml(t.app)}</strong> · ${escHtml(t.name)}</span>
        <span class="peer-fd-phase">${escHtml(t.phase || t.status)}</span>
        ${running || t.status === 'done' ? `<span class="peer-fd-bar"><span class="peer-fd-fill" style="width:${pct}%"></span></span>` : ''}
        <span class="peer-fd-bytes">${escHtml(bytes + blobs)}</span>
        <span class="peer-fd-result">${escHtml(result)}${refused ? ` <span class="bad">— cancel refused: ${escHtml(refused)}</span>` : ''}</span>
        ${running ? `<button class="setup-btn setup-btn-danger" data-act="fd-cancel" data-id="${escHtml(t.id)}">Cancel</button>` : ''}
      </div>`;
  }

  function dataBoxHtml(peerName) {
    const rows = dataTransfersFor(peerName);
    if (!rows.length) return '';
    return `<div class="peer-fd-title">Data publishes</div>${rows.map(dataRowHtml).join('')}`;
  }

  function renderDataBox(peerName) {
    if (!remotePaneEl || !remotePaneEl.isConnected || typeof peerName !== 'string') return;
    const box = remotePaneEl.querySelector(`[data-fd-peer="${CSS.escape(peerName)}"]`);
    if (!box) return;
    box.innerHTML = dataBoxHtml(peerName);
    box.querySelectorAll('[data-act="fd-cancel"]').forEach((btn) => btn.addEventListener('click', async () => {
      const t = peerState.dataTransfers.find((x) => x.id === btn.dataset.id);
      const isUp = t?.dir === 'up';
      const what = t ? `"${t.name}" of ${t.app} ${isUp ? 'from' : 'to'} ${t.peer}` : 'this data publish';
      const drop = isUp ? 'This master drops what it received so far; publishing again from the app on the slave starts over.' : 'The slave drops what it received so far; publishing again from the app starts over.';
      if (!(await showConfirm(`Cancel the data publish ${what}?\n\n${drop}`, { confirmLabel: 'Cancel publish', danger: true }))) return;
      delete peerState.dataErrors[btn.dataset.id];
      btn.disabled = true;
      sendWs({ type: 'app:fleet:data:cancel', id: btn.dataset.id });
    }));
  }

  function renderAllDataBoxes() {
    if (!remotePaneEl || !remotePaneEl.isConnected) return;
    remotePaneEl.querySelectorAll('[data-fd-peer]').forEach((el) => renderDataBox(el.dataset.fdPeer));
  }

  // Publish history + one-click rollback for one app on one slave. The
  // rollback runs as a persistent master-side job (GUI-reload resilient via
  // app:publish:rollbackStatus polling, like the publish wizard).
  function showHistory(peerName, appName, opts) {
    const host = embedHost(opts);
    const modal = host.modal;
    const embedded = !host.backdrop;

    let pollTimer = null;
    const close = () => {
      if (pollTimer) clearInterval(pollTimer);
      onHistory = onRollbackStarted = onRollbackStatus = null;
      host.remove();
    };
    wireStandaloneClose(host, close);

    const head = `
      <div class="publish-head">
        <div>
          <div class="publish-title">History — <strong>${escHtml(appName)}</strong> on <strong>${escHtml(peerName)}</strong></div>
          <div class="publish-sub">Versions this slave still holds can be rolled back without a new publish</div>
        </div>
        <button class="publish-x" aria-label="Close"${embedded ? ' title="Back to the remote state"' : ''}>${embedded ? '&larr;' : '&times;'}</button>
      </div>`;
    const wireClose = () => modal.querySelector('.publish-x')?.addEventListener('click', close);

    function renderHistory(m) {
      if (m.error) {
        modal.innerHTML = head + `<div class="publish-body"><div class="publish-error">${escHtml(m.error)}</div></div>`;
        wireClose();
        return;
      }
      const rows = (m.history || []).map((h, i) => {
        const current = h.commit === m.commit && i === 0;
        return `
          <div class="setup-row peer-row">
            <span><code>${escHtml(String(h.commit).slice(0, 10))}</code> <span class="peer-url">${h.deployedAt ? new Date(h.deployedAt).toLocaleString() : ''}</span>${current ? ' <span class="peer-fleet-current">current</span>' : ''}</span>
            <span>${!current && h.bundle ? `<button class="setup-btn" data-act="rollback" data-commit="${escHtml(h.commit)}">Roll back</button>` : (!current ? '<span class="setup-hint" style="margin:0;">bundle no longer kept</span>' : '')}</span>
          </div>`;
      }).join('');
      modal.innerHTML = head + `
        <div class="publish-body">
          ${rows || '<div class="setup-hint">No deploys recorded on this slave yet (history starts with the first publish after the federation update).</div>'}
          ${m.dataBackups?.length ? `<div class="publish-hint">Data is never rolled back automatically — this slave still holds ${m.dataBackups.length} data backup(s) from an older data import in the app's <code>.peer-backup/</code> (newest: ${new Date(Number(m.dataBackups[0])).toLocaleString()}).</div>` : ''}
          <div class="publish-actions"><button class="setup-btn" data-act="close">Close</button></div>
        </div>`;
      wireClose();
      modal.querySelector('[data-act="close"]').addEventListener('click', close);
      modal.querySelectorAll('[data-act="rollback"]').forEach((btn) => btn.addEventListener('click', async () => {
        const commit = btn.dataset.commit;
        if (!(await showConfirm(`Roll back "${appName}" on "${peerName}" to ${commit.slice(0, 10)}?\n\nThe slave replaces the app's code with that kept version and restarts it. Data is NOT rolled back.`, { confirmLabel: 'Roll back', danger: true }))) return;
        onRollbackStarted = (r) => {
          if (r.error) {
            modal.querySelector('.publish-body')?.insertAdjacentHTML('afterbegin', `<div class="publish-error">${escHtml(r.error)}</div>`);
            return;
          }
          startRollbackPolling();
        };
        sendWs({ type: 'app:publish:rollback', name: appName, peer: peerName, commit });
        renderRollbackProgress(null);
      }));
    }

    function renderRollbackProgress(job) {
      const steps = job?.meta?.steps || [];
      const running = !job || job.status === 'running';
      const done = job?.status === 'done';
      const failed = job && !running && !done;
      modal.innerHTML = head + `
        <div class="publish-body">
          <div class="publish-progress-bar"><div class="publish-progress-fill${failed ? ' bad' : ''}" style="width:${done ? 100 : (job?.progress?.pct ?? 0)}%"></div></div>
          <div class="publish-progress-label">${escHtml(job?.progress?.label || 'Starting rollback…')}</div>
          <div class="publish-steplist">
            ${steps.map((s) => `
              <div class="publish-step ${s.status}">
                ${stepIconHtml(s.status)}
                <span class="publish-step-label">${escHtml(s.label)}</span>
                <span class="publish-step-detail">${escHtml(s.detail || '')}</span>
              </div>`).join('')}
          </div>
          ${done ? '<div class="publish-result ok">Rolled back.</div>' : ''}
          ${failed ? `<div class="publish-result bad">${escHtml(job.error || 'Rollback ' + job.status)}</div>` : ''}
          <div class="publish-actions"><button class="setup-btn" data-act="close">${running ? 'Hide (keeps running)' : 'Close'}</button></div>
        </div>`;
      wireClose();
      modal.querySelector('[data-act="close"]').addEventListener('click', close);
    }

    function startRollbackPolling() {
      if (pollTimer) clearInterval(pollTimer);
      onRollbackStatus = (m) => {
        if (m.appName !== appName || !m.job) return;
        renderRollbackProgress(m.job);
        if (m.job.status !== 'running' && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      };
      pollTimer = setInterval(() => sendWs({ type: 'app:publish:rollbackStatus', name: appName }), 1000);
      sendWs({ type: 'app:publish:rollbackStatus', name: appName });
    }

    modal.innerHTML = head + '<div class="publish-body"><div class="publish-loading">Fetching history from the slave…</div></div>';
    wireClose();
    onHistory = (m) => {
      if (m.peer !== peerName || m.appName !== appName) return;
      // A rollback already running for this app reattaches instead (reload resilience).
      renderHistory(m);
    };
    onRollbackStatus = (m) => {
      if (m.appName === appName && m.job?.status === 'running') { renderRollbackProgress(m.job); startRollbackPolling(); }
    };
    sendWs({ type: 'app:publish:rollbackStatus', name: appName });
    sendWs({ type: 'app:publish:history', peer: peerName, name: appName });
    return close;
  }

  // stepIcon lives inside showPublish's closure; the history modal needs it too.
  function stepIconHtml(status) {
    if (status === 'done') return '<span class="publish-step-ico ok">&#10003;</span>';
    if (status === 'running') return '<span class="publish-step-ico spin"></span>';
    if (status === 'failed') return '<span class="publish-step-ico bad">&#10007;</span>';
    return '<span class="publish-step-ico pend"></span>';
  }

  // --- Remote sessions (master; docs/remote-sessions.md) --------------------
  // Each linked slave's row holds a [data-rs-peer] box; a sessions:state
  // broadcast re-renders only those boxes, so the pane (and an open launch
  // dialog) is left alone.

  const rsViewFor = (name) => peerState.rs.peers.find((p) => p.peer === name) || null;

  function renderRsSections() {
    if (!remotePaneEl?.isConnected || peerState.role === 'slave') return;
    remotePaneEl.querySelectorAll('[data-rs-peer]').forEach(renderRsSection);
  }

  function renderRsSection(el) {
    const peer = el.dataset.rsPeer;
    const { alerts, notices, errors } = peerState.rs;
    el.innerHTML = rsView.sectionHtml(rsViewFor(peer), peer, { alert: alerts[peer], notice: notices[peer], error: errors[peer] });
    if (el._rsBound) return;
    el._rsBound = true;
    el.addEventListener('change', (e) => {
      const box = e.target.closest('input[data-act="rs-joinruns"]');
      if (!box) return;
      delete peerState.rs.errors[peer];
      sendWs({ type: 'app:peer:session:joinRuns', peer, on: box.checked });
    });
    el.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act;
      if (act === 'rs-launch') showRemoteLaunch(peer);
      else if (act === 'rs-synckeys') showKeySync(peer);
      else if (act === 'rs-dismiss') {
        // Server-side dismiss: the alert is kept there until then (reload / restart).
        rsDismissPeer = peer;
        sendWs({ type: 'app:peer:remoteAlert:dismiss', peer });
        delete peerState.rs.alerts[peer];
        renderRsSection(el);
      }
      else if (act === 'rs-open') {
        const cli = window.cliModule;
        if (cli?.tabs?.has(btn.dataset.tab)) {
          cli.switchTab(btn.dataset.tab);
          if (typeof switchView === 'function') switchView('claude');
        } else {
          peerState.rs.errors[peer] = 'That tab is not open in this dashboard.';
          renderRsSection(el);
        }
      } else if (act === 'rs-kill') {
        const s = rsViewFor(peer)?.sessions?.find((x) => x.tabId === btn.dataset.tab);
        const title = rsView.capText(s?.title || s?.app || '', 120) || 'this session';
        if (!(await showConfirm(`Kill the remote session "${title}" on "${peer}"?\n\nThe session stops on the slave; its tab stays until closed.`, { confirmLabel: 'Kill', danger: true }))) return;
        const reqId = `rs-kill-${++rsSeq}`;
        rsKills.set(reqId, peer);
        delete peerState.rs.errors[peer];
        sendWs({ type: 'app:peer:session:kill', reqId, tabId: btn.dataset.tab });
      }
    });
  }

  // The launch form for one slave. The server re-checks everything; the
  // form only mirrors the slave's snapshot so a refusal is rarely a surprise.
  function showRemoteLaunch(peerName) {
    document.querySelector('.publish-modal-backdrop')?.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'alert-modal-backdrop publish-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'alert-modal publish-modal';
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = () => {
      onLaunchResult = null;
      backdrop.remove();
    };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });

    const view = rsViewFor(peerName);
    const apps = rsView.appsFromFleet(fleetFor(peerName));
    const models = window.cliModule?.modelPickerOptions?.() || [];
    const blocked = rsView.launchBlocked(view, peerName);
    modal.innerHTML = `
      <div class="publish-head">
        <div>
          <div class="publish-title">Launch on <strong>${escHtml(peerName)}</strong></div>
          <div class="publish-sub">An Agent SDK session on the slave, followed here</div>
        </div>
        <button class="publish-x" aria-label="Close">&times;</button>
      </div>
      <div class="publish-body">
        ${rsView.launchFormHtml(view, peerName, { apps, models })}
        <div id="rsLaunchStatus" class="setup-status"></div>
        <div class="publish-actions">
          <button class="setup-btn" data-act="cancel">Cancel</button>
          ${blocked ? '' : `<button class="setup-btn setup-btn-primary" data-act="launch" ${apps.length ? '' : 'disabled'}>Launch</button>`}
        </div>
      </div>`;
    modal.querySelector('.publish-x').addEventListener('click', close);
    modal.querySelector('[data-act="cancel"]').addEventListener('click', close);

    const statusEl = modal.querySelector('#rsLaunchStatus');
    const launchBtn = modal.querySelector('[data-act="launch"]');
    const fail = (text) => { statusEl.innerHTML = `<span class="setup-check fail">${escHtml(text)}</span>`; };
    launchBtn?.addEventListener('click', () => {
      const prompt = modal.querySelector('#rsPrompt').value;
      const auth = modal.querySelector('input[name="rsAuth"]:checked')?.value;
      if (!prompt.trim()) { fail('Write a prompt first.'); return; }
      if (!auth) { fail(`No billing option is available on ${peerName}.`); return; }
      const reqId = `rs-launch-${++rsSeq}`;
      const msg = {
        type: 'app:peer:session:launch', reqId, peer: peerName,
        mode: modal.querySelector('input[name="rsMode"]:checked')?.value || 'simple',
        app: modal.querySelector('#rsApp').value, prompt, auth,
      };
      const model = modal.querySelector('#rsModel').value;
      if (model) msg.model = model;
      launchBtn.disabled = true;
      statusEl.innerHTML = '<span class="setup-check loading">Launching…</span>';
      onLaunchResult = (m) => {
        if (m.reqId !== reqId) return;
        if (m.ok) {
          close();
          if (window.cliModule?.tabs?.has(m.tabId)) {
            window.cliModule.switchTab(m.tabId);
            if (typeof switchView === 'function') switchView('claude');
          }
          return;
        }
        launchBtn.disabled = false;
        fail(rsView.errorText(m.code, peerName, m.error));
      };
      sendWs(msg);
    });
  }

  // --- Setup → Remote pane --------------------------------------------------

  let remotePaneEl = null;

  function renderRemotePaneIfOpen() {
    if (remotePaneEl && remotePaneEl.isConnected) renderRemotePane(remotePaneEl);
    else remotePaneEl = null;
  }

  function renderRemotePane(container) {
    remotePaneEl = container;
    const isSlave = peerState.role === 'slave';
    const sl = peerState.slave || {};

    let slaveSection;
    if (isSlave) {
      const statusLabel = { pending: 'Waiting for approval on the master…', linked: 'Linked to master', denied: 'Denied by the master', expired: 'Request expired' }[sl.linkStatus] || 'Not linked';
      slaveSection = `
        <div class="setup-section">
          <div class="setup-section-title">Slave mode</div>
          <div class="setup-row"><span>Status</span><span class="setup-check ${sl.linkStatus === 'linked' ? 'ok' : sl.linkStatus === 'pending' ? 'loading' : 'fail'}">${escHtml(statusLabel)}</span></div>
          <div class="setup-row"><span>Name</span><span>${escHtml(sl.name || '—')}</span></div>
          <div class="setup-row"><span>Master</span><span>${escHtml(sl.masterUrl || '—')}</span></div>
          <div class="setup-row"><span>Hosted apps</span><span>${escHtml((peerState.enabledApps || []).join(', ') || 'none yet — publish from the master')}</span></div>
          <div class="setup-hint">Apps published from the master are read-only mirrors here — edit them on the master and publish again. Their configuration (access level, login channels, custom domain) is per host: App Config here saves for this slave only and survives publishes. Apps created locally on this instance stay fully editable and start/autostart as normal.</div>
          <div class="setup-row"><span>Remote sessions</span><span>
            <label><input type="checkbox" data-rs="enabled" ${peerState.remoteSessions.enabled ? 'checked' : ''}> Let the master launch Agent SDK sessions here</label><br>
            <label><input type="checkbox" data-rs="allowApiKey" ${peerState.remoteSessions.allowApiKey ? 'checked' : ''} ${peerState.remoteSessions.enabled ? '' : 'disabled'}> &hellip;billed to this server's API key</label>
          </span></div>
          <div class="setup-hint">Off by default. Only over HTTPS; at most 3 at once and 10 per hour; every launch is logged here. Changeable only on this dashboard.</div>
          <div class="setup-btn-row">
            ${sl.linkStatus !== 'linked' ? '<button class="setup-btn" data-act="repair">Re-send pairing request</button>' : ''}
            <button class="setup-btn setup-btn-danger" data-act="unlink">Disable slave mode</button>
          </div>
        </div>`;
    } else {
      slaveSection = `
        <div class="setup-section">
          <div class="setup-section-title">Slave mode</div>
          <div class="setup-hint">Turn this instance into a <strong>slave</strong> of another vistaclair master: it becomes a read-only mirror that the master publishes apps to. Requires the master's approval (Horst / Telegram).</div>
          <div class="app-create-form">
            <label>This slave's name<input id="peerSlaveName" type="text" placeholder="e.g. hetzner-1" value="${escHtml(sl.name || '')}"></label>
            <label>Master URL<input id="peerSlaveMaster" type="url" placeholder="https://master.example.com" value="${escHtml(sl.masterUrl || '')}"></label>
            <label>This server's public URL<input id="peerSlavePublic" type="url" value="${escHtml(sl.publicUrl || window.location.origin)}"></label>
          </div>
          <div id="peerSlaveStatus" class="setup-status"></div>
          <div class="setup-btn-row"><button class="setup-btn setup-btn-primary" data-act="link">Enable slave mode &amp; request link</button></div>
        </div>`;
    }

    const peersSection = isSlave ? '' : `
      <div class="setup-section">
        <div class="setup-section-title">Linked slaves</div>
        ${peerState.peers.length ? peerState.peers.map((p) => {
          const cached = testResultView(peerState.testResults[p.name]);
          const keys = keysSyncView(p);
          return `
          <div class="setup-row peer-row">
            <span><strong>${escHtml(p.name)}</strong> <span class="peer-url">${escHtml(p.baseUrl)}</span></span>
            <span class="peer-row-actions">
              <span class="peer-test-result${cached ? ' ' + cached.cls : ''}" data-peer-test="${escHtml(p.name)}">${cached ? escHtml(cached.text) : ''}</span>
              <button class="setup-btn" data-act="test" data-id="${escHtml(p.name)}">Test</button>
              <button class="setup-btn" data-act="access" data-id="${escHtml(p.name)}" title="Get a one-time login link to this slave's dashboard">Access</button>
              <button class="setup-btn" data-act="synckeys" data-id="${escHtml(p.name)}" title="Copy this master's provider API keys and model registry to this slave">Sync keys</button>
              <button class="setup-btn" data-act="trustclicks" data-id="${escHtml(p.name)}" data-on="${p.trustOwnerClicks ? '1' : ''}" title="When on, data this slave publishes to the master on its owner's click starts without an approval here. When off (default) each such publish files an approval on this master.">Owner clicks: ${p.trustOwnerClicks ? 'trusted' : 'need approval'}</button>
              <button class="setup-btn" data-act="restart" data-id="${escHtml(p.name)}" title="Restart vistaclair on this slave">Restart</button>
              <button class="setup-btn setup-btn-danger" data-act="kill" data-id="${escHtml(p.name)}" title="Emergency kill-switch: shuts vistaclair OFF on this slave">Kill</button>
              <button class="setup-btn setup-btn-danger" data-act="remove" data-id="${escHtml(p.name)}">Unlink</button>
            </span>
          </div>
          <div class="peer-keys-line ${keys.cls}">${escHtml(keys.text)}</div>
          ${fleetLines(p)}
          <div class="peer-fd" data-fd-peer="${escHtml(p.name)}"></div>
          <div class="peer-rs" data-rs-peer="${escHtml(p.name)}"></div>
          <div class="peer-access-panel" data-peer-access="${escHtml(p.name)}" hidden></div>`;
        }).join('') : '<div class="setup-hint">No slaves linked. On the remote server open Setup &rarr; Remote and enable Slave mode with this master\'s URL.</div>'}
        ${peerState.requests.length ? `
          <div class="setup-section-title" style="margin-top:12px;">Pending pairing requests</div>
          ${peerState.requests.map((r) => `
            <div class="setup-row peer-row pending">
              <span><strong>${escHtml(r.name)}</strong> <span class="peer-url">${escHtml(r.publicUrl)}</span></span>
              <span class="setup-hint" style="margin:0;">approve in Horst approvals or Telegram</span>
            </div>`).join('')}` : ''}
      </div>`;

    container.innerHTML = `
      <div class="setup-pane-intro">
        <h3>Remote &mdash; Master / Slave</h3>
        <p>Publish apps from this master to linked slave servers, or make this instance a slave of another master. Slaves receive committed code as explicit per-app publishes, and app data through the apps' own data publishes — only published apps are touched there.</p>
      </div>
      ${peersSection}
      ${slaveSection}`;
    renderRsSections();
    renderAllDataBoxes();

    // One pane-level result handler serves manual Test clicks and the
    // automatic on-open checks alike (results route by peer name).
    onTestResult = (m) => {
      const target = container.querySelector(`[data-peer-test="${CSS.escape(m.id)}"]`);
      const view = testResultView(m);
      if (target && view) {
        target.textContent = view.text;
        target.className = 'peer-test-result ' + view.cls;
      }
    };
    const runTest = (id) => {
      const el = container.querySelector(`[data-peer-test="${CSS.escape(id)}"]`);
      if (el) { el.textContent = 'checking…'; el.className = 'peer-test-result'; }
      sendWs({ type: 'app:peer:test', id });
    };
    container.querySelectorAll('[data-act="test"]').forEach((btn) => btn.addEventListener('click', () => runTest(btn.dataset.id)));
    // Check each slave automatically when the pane comes up, so reachability
    // and software versions show without a click (throttled per peer).
    for (const p of peerState.peers) {
      if (Date.now() - (peerState.lastAutoTest[p.name] || 0) > 60000) {
        peerState.lastAutoTest[p.name] = Date.now();
        runTest(p.name);
      }
    }
    container.querySelectorAll('[data-act="trustclicks"]').forEach((btn) => btn.addEventListener('click', async () => {
      const turnOn = !btn.dataset.on;
      if (turnOn && !(await showConfirm(`Trust "${btn.dataset.id}" to say which data publishes come from its owner? A compromised slave could then push data into this master's apps without an approval.`, { confirmLabel: 'Trust', danger: true }))) return;
      sendWs({ type: 'app:peer:trustOwnerClicks', id: btn.dataset.id, value: turnOn });
      // A server that has not been restarted since this setting was added
      // ignores the message: say so when the peer list does not change.
      setTimeout(() => {
        const cur = (peerState.peers || []).find((x) => x.name === btn.dataset.id || x.id === btn.dataset.id);
        if (cur && (cur.trustOwnerClicks === true) === turnOn) return;
        const el = container.querySelector(`[data-peer-test="${CSS.escape(btn.dataset.id)}"]`);
        if (el) { el.textContent = 'not applied — this server needs a restart for this setting'; el.className = 'peer-test-result bad'; }
      }, 4000);
    }));
    container.querySelectorAll('[data-act="synckeys"]').forEach((btn) => btn.addEventListener('click', () => showKeySync(btn.dataset.id)));
    container.querySelectorAll('[data-act="history"]').forEach((btn) => btn.addEventListener('click', () => showHistory(btn.dataset.peer, btn.dataset.app)));
    container.querySelectorAll('[data-act="remove"]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!(await showConfirm(`Unlink slave "${btn.dataset.id}"? The master will no longer be able to publish to it.`, { confirmLabel: 'Unlink', danger: true }))) return;
      sendWs({ type: 'app:peer:remove', id: btn.dataset.id });
    }));

    // Access panel: asks the slave for a one-time login link (single use,
    // short-lived; a fresh one on every click of Access). The permanent token
    // is never shown — except for a slave too old to know better, which comes
    // with an "outdated" warning (src/apps/peer-access.js).
    onAccessResult = (m) => {
      const panel = container.querySelector(`[data-peer-access="${CSS.escape(m.id)}"]`);
      if (!panel) return;
      panel.hidden = false;
      if (!m.ok) { panel.innerHTML = `<span class="setup-check fail">${escHtml(m.error || 'failed')}</span>`; return; }
      const mins = m.expiresInMs ? Math.max(1, Math.round(m.expiresInMs / 60000)) : null;
      panel.innerHTML = `
        ${m.warning ? `<div class="publish-warn">${escHtml(m.warning)}</div>` : ''}
        ${m.loginUrl
          ? `<a class="peer-access-link" href="${escHtml(m.loginUrl)}" target="_blank" rel="noopener noreferrer">Open the slave's dashboard (one-time login${mins ? `, valid ${mins} min` : ''})</a>`
          : (m.url ? `<a class="peer-access-link" href="${escHtml(m.url)}" target="_blank" rel="noopener">${escHtml(m.url)}</a>` : '')}
        ${m.token ? `<code class="peer-access-token" title="Click to copy to clipboard">${escHtml(m.token)}</code>`
          : (!m.loginUrl ? '<span class="setup-hint" style="margin:0;">slave reported no access token</span>' : '')}`;
      const tokenEl = panel.querySelector('.peer-access-token');
      tokenEl?.addEventListener('click', () => {
        navigator.clipboard?.writeText(m.token).then(() => {
          tokenEl.classList.add('copied');
          setTimeout(() => tokenEl.classList.remove('copied'), 1500);
        }).catch(() => {});
      });
    };
    container.querySelectorAll('[data-act="access"]').forEach((btn) => btn.addEventListener('click', () => {
      const panel = container.querySelector(`[data-peer-access="${CSS.escape(btn.dataset.id)}"]`);
      if (panel && !panel.hidden) { panel.hidden = true; panel.innerHTML = ''; return; }
      if (panel) { panel.hidden = false; panel.innerHTML = '<span class="setup-check loading">fetching…</span>'; }
      sendWs({ type: 'app:peer:access', id: btn.dataset.id });
    }));

    // Restart / kill results land in the same status span the Test button uses.
    onOpResult = (m) => {
      const el = container.querySelector(`[data-peer-test="${CSS.escape(m.id)}"]`);
      if (!el) return;
      if (m.ok) {
        el.textContent = m.op === 'kill' ? 'kill-switch sent — instance shutting down' : 'restart sent';
        el.className = 'peer-test-result ' + (m.op === 'kill' ? 'warn' : 'ok');
      } else {
        el.textContent = `${m.op} failed: ${m.error || 'unknown error'}`;
        el.className = 'peer-test-result bad';
      }
    };
    const sendOp = (id, type, pendingLabel) => {
      const el = container.querySelector(`[data-peer-test="${CSS.escape(id)}"]`);
      if (el) { el.textContent = pendingLabel; el.className = 'peer-test-result'; }
      sendWs({ type, id });
    };
    container.querySelectorAll('[data-act="restart"]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!(await showConfirm(`Restart vistaclair on slave "${btn.dataset.id}"? It will be briefly unavailable while it comes back up.`, { confirmLabel: 'Restart' }))) return;
      sendOp(btn.dataset.id, 'app:peer:restart', 'sending restart…');
    }));
    container.querySelectorAll('[data-act="kill"]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!(await showConfirm(`EMERGENCY KILL-SWITCH for slave "${btn.dataset.id}":\n\nThis shuts vistaclair OFF on that server — the dashboard and all its apps go down and stay down until someone starts it again on the machine itself.\n\nProceed?`, { confirmLabel: 'Kill', danger: true }))) return;
      sendOp(btn.dataset.id, 'app:peer:kill', 'sending kill…');
    }));
    container.querySelector('[data-act="link"]')?.addEventListener('click', () => {
      const name = container.querySelector('#peerSlaveName')?.value?.trim();
      const masterUrl = container.querySelector('#peerSlaveMaster')?.value?.trim();
      const publicUrl = container.querySelector('#peerSlavePublic')?.value?.trim();
      const statusEl = container.querySelector('#peerSlaveStatus');
      if (!name || !masterUrl || !publicUrl) { statusEl.innerHTML = '<span class="setup-check fail">All three fields are required</span>'; return; }
      statusEl.innerHTML = '<span class="setup-check loading">Contacting master…</span>';
      onSlaveResult = (m) => {
        if (!m.ok) statusEl.innerHTML = `<span class="setup-check fail">${escHtml(m.error || 'failed')}</span>`;
      };
      sendWs({ type: 'app:peer:slaveStart', name, masterUrl, publicUrl });
    });
    container.querySelectorAll('[data-rs]').forEach((box) => box.addEventListener('change', () => {
      sendWs({ type: 'app:peer:remoteSessions', [box.dataset.rs]: box.checked });
    }));
    container.querySelector('[data-act="repair"]')?.addEventListener('click', () => {
      const s = peerState.slave || {};
      sendWs({ type: 'app:peer:slaveStart', name: s.name, masterUrl: s.masterUrl, publicUrl: s.publicUrl });
    });
    container.querySelector('[data-act="unlink"]')?.addEventListener('click', async () => {
      if (!(await showConfirm('Disable slave mode? The link to the master is severed (the master should also unlink this slave).', { confirmLabel: 'Disable slave mode', danger: true }))) return;
      sendWs({ type: 'app:peer:slaveReset' });
    });
  }

  window.publishModule = {
    showPublish,
    showHistory,
    renderRemotePane,
    isMaster: () => peerState.role !== 'slave',
    state: peerState,
  };

  // Pull current peering state (the server's onConnect send may predate this script).
  function requestState() {
    if (window.dashboard.state.ws?.readyState === 1) {
      sendWs({ type: 'app:peer:slaveStatus' });
      sendWs({ type: 'app:peer:list' });
      sendWs({ type: 'app:peer:keysStatus' });
      sendWs({ type: 'app:fleet:state' });
      sendWs({ type: 'app:fleet:data:list' });
      sendWs({ type: 'app:peer:session:list' });
    } else {
      setTimeout(requestState, 300);
    }
  }
  requestState();
})();
