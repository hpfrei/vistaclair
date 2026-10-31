// Labels for remote sessions: an SDK tab whose session runs on another machine
// (settings.externalHost) and an ask:question it raised (msg.host, msg.remote),
// and the ask:answer that answers such an ask.
// These strings come from another machine through an add-on, so they are
// untrusted: capped here and only ever set as text (remoteLabelEl), never HTML.
// Pure: nothing touches the page's DOM except through the document passed in.
(function (root) {
  const HOST_MAX = 100;
  const TITLE_MAX = 200;

  // A string with control characters flattened to spaces, trimmed, and cut to
  // `max` characters with an ellipsis. Anything not a string is ''.
  function capText(s, max) {
    if (typeof s !== 'string') return '';
    const flat = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    const chars = Array.from(flat);
    return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : flat;
  }

  // "Remote · <host>" for a tab's settings, or null for a local tab.
  function hostBadgeLabel(settings) {
    const host = capText(settings?.externalHost, HOST_MAX);
    return host ? `Remote · ${host}` : null;
  }

  // "Remote · <host> · <sessionTitle>" for an ask:question carrying `host`
  // ("· <sessionTitle>" only when remote.sessionTitle is set), or null for a
  // local ask.
  function remoteAskLabel(msg) {
    const host = capText(msg?.host, HOST_MAX);
    if (!host) return null;
    const title = capText(msg.remote?.sessionTitle, TITLE_MAX);
    return title ? `Remote · ${host} · ${title}` : `Remote · ${host}`;
  }

  // A <span class=cls> holding `text` as a text node.
  function remoteLabelEl(doc, text, cls) {
    const el = doc.createElement('span');
    if (cls) el.className = cls;
    el.appendChild(doc.createTextNode(text));
    return el;
  }

  // The ask:answer for one form of the ask:question `msg`. An answer to an
  // external ask (msg.host or msg.remote set, or raised in an external
  // session's tab: externalTab) names the tab it answers — msg.tabId, else
  // msg.remote.tabId — or the server refuses it. A local ask's answer stays
  // { type, toolUseId, answer, files }.
  function askAnswerMsg(msg, externalTab, toolUseId, answer, files) {
    const out = { type: 'ask:answer', toolUseId, answer };
    if (files !== undefined) out.files = files;
    const external = msg?.host != null || msg?.remote != null || externalTab === true;
    const tabId = msg?.tabId ?? msg?.remote?.tabId;
    if (external && tabId != null) out.tabId = tabId;
    return out;
  }

  const api = { capText, hostBadgeLabel, remoteAskLabel, remoteLabelEl, askAnswerMsg, HOST_MAX, TITLE_MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.remoteAsk = api;
})(typeof window !== 'undefined' ? window : globalThis);
