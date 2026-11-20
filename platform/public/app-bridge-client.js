// === App Bridge Client ===
// Relays postMessage bridge calls from app iframes to the server via WebSocket
(function() {
  'use strict';
  const { sendWs } = window.dashboard;
  const origin = window.location.origin;

  // pendingCalls keyed by "appName:callId" to prevent cross-app ID collision
  const pendingCalls = new Map();
  let bridgeSeq = 0;

  function findAppIframe(source) {
    const iframes = document.querySelectorAll('iframe[data-app-iframe]');
    for (const iframe of iframes) {
      if (iframe.contentWindow === source) return iframe;
    }
    return null;
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'app:error:report') {
      const iframe = findAppIframe(e.source);
      if (iframe) {
        const appName = iframe.dataset.appIframe;
        if (appName && window.appsModule?.reportError) {
          window.appsModule.reportError(appName, msg.error);
        }
      }
      return;
    }
    if (msg && msg.type === 'notify') {
      if (window.dashboard?.showToast) {
        const iframe = findAppIframe(e.source);
        const appName = iframe?.dataset?.appIframe || '';
        window.dashboard.showToast({ sender: appName, title: msg.title, message: msg.body, level: msg.level });
      }
      return;
    }
    if (!msg || msg.type !== 'bridge') return;

    const iframe = findAppIframe(e.source);
    if (!iframe) return;

    const appName = iframe.dataset.appIframe;
    if (!appName) {
      e.source.postMessage({ id: msg.id, error: 'No app context' }, origin);
      return;
    }

    // Generate a unique server-side ID, map it back to the iframe's original ID
    const serverId = String(++bridgeSeq);
    pendingCalls.set(appName + ':' + serverId, { appName, iframeId: msg.id });

    sendWs({
      type: 'app:bridge',
      name: appName,
      id: serverId,
      method: msg.method,
      params: msg.params,
    });
  });

  function handleBridgeResponse(msg) {
    if (msg.type !== 'app:bridge:response') return false;
    const appName = msg.appName;
    const key = appName + ':' + msg.id;
    const pending = pendingCalls.get(key);
    pendingCalls.delete(key);
    if (!pending) return false;

    const iframe = document.querySelector(`iframe[data-app-iframe="${CSS.escape(pending.appName)}"]`);
    if (!iframe?.contentWindow) return false;

    iframe.contentWindow.postMessage({
      id: pending.iframeId,
      result: msg.result,
      error: msg.error,
    }, origin);
    return true;
  }

  function handleBridgeEvent(msg) {
    if (msg.type !== 'app:bridge:event') return false;
    const targetApp = msg.appName;
    if (targetApp) {
      const iframe = document.querySelector(`iframe[data-app-iframe="${CSS.escape(targetApp)}"]`);
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({
          type: 'bridge:event',
          event: msg.event,
          data: msg.data,
        }, origin);
      }
    }
    return true;
  }

  window.dashboard.registerModule('app:bridge:', function(msg) {
    handleBridgeResponse(msg) || handleBridgeEvent(msg);
  });
})();
