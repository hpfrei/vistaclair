// The LemonSqueezy checkout overlay (pro-header.js) reports a purchase with a
// Checkout.Success postMessage, and its order id is claimed for a license
// (POST /api/pro/claim). Any frame, opener or tab can post to the dashboard
// window, so a message counts only from a checkout origin — lemon.js's own
// or the origin of a checkout URL the server listed — with the expected shape
// and an order id that looks like one.
(function (root) {
  const LEMON_ORIGIN = 'https://app.lemonsqueezy.com';
  const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

  // The origins a checkout message may come from, given the variants'
  // checkout URLs. Only https origins; anything unparsable is skipped.
  function checkoutOrigins(checkoutUrls) {
    const origins = new Set([LEMON_ORIGIN]);
    for (const u of checkoutUrls || []) {
      try {
        const url = new URL(u);
        if (url.protocol === 'https:') origins.add(url.origin);
      } catch {}
    }
    return origins;
  }

  // The order id of a genuine Checkout.Success message, else null.
  // Shape: { event: 'Checkout.Success', data: { order: { id } | { data: { id } } } }.
  function checkoutOrderId(event, origins) {
    if (!event || typeof event.origin !== 'string' || !origins || !origins.has(event.origin)) return null;
    const d = event.data;
    if (!d || typeof d !== 'object' || d.event !== 'Checkout.Success') return null;
    const order = d.data && typeof d.data === 'object' ? d.data.order : null;
    if (!order || typeof order !== 'object') return null;
    let id = order.id != null ? order.id : (order.data && typeof order.data === 'object' ? order.data.id : null);
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) id = String(id);
    if (typeof id !== 'string' || !ORDER_ID.test(id)) return null;
    return id;
  }

  const api = { checkoutOrigins, checkoutOrderId, LEMON_ORIGIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.checkoutMsg = api;
})(typeof window !== 'undefined' ? window : globalThis);
