// Per-app SSE registry for cookieless clients (e.g. Telegram webviews) that
// can't use the cookie-gated platform WebSocket. Backs ctx.sse: handler()
// produces an express route handler, emit() fans out to that app's subscribers.
const clients = new Map(); // appName → Map<channel, Set<res>>

const PING_INTERVAL_MS = 25000;

function channelsFor(appName) {
  if (!clients.has(appName)) clients.set(appName, new Map());
  return clients.get(appName);
}

// handler(channelFn?) → (req, res) express handler. channelFn(req) may return a
// channel key (e.g. a job id from req.params); default channel is 'default'.
function handler(appName, channelFn) {
  return (req, res) => {
    let channel = 'default';
    try { channel = String((channelFn && channelFn(req)) ?? 'default'); } catch {}

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const channels = channelsFor(appName);
    if (!channels.has(channel)) channels.set(channel, new Set());
    channels.get(channel).add(res);

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, PING_INTERVAL_MS);

    req.on('close', () => {
      clearInterval(ping);
      const set = channels.get(channel);
      if (set) {
        set.delete(res);
        if (set.size === 0) channels.delete(channel);
      }
    });
  };
}

// Best-effort by contract: never throws (a failed SSE write must not be able
// to break an app's job lifecycle or run chain).
function emit(appName, event, data, channel) {
  let payload;
  try {
    payload = `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
  } catch {
    return 0; // non-serializable data
  }
  const set = clients.get(appName)?.get(String(channel ?? 'default'));
  if (!set || set.size === 0) return 0;
  let sent = 0;
  for (const res of set) {
    try { res.write(payload); sent++; } catch { set.delete(res); }
  }
  return sent;
}

function cleanupApp(appName) {
  const channels = clients.get(appName);
  if (!channels) return;
  for (const set of channels.values()) {
    for (const res of set) {
      try { res.end(); } catch {}
    }
  }
  clients.delete(appName);
}

module.exports = { handler, emit, cleanupApp };
