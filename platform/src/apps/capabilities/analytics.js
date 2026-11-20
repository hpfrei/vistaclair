// Capability: analytics — `ctx.analytics` / Bridge `analytics.*`: privacy-friendly
// counting for the app's own sites (docs/analytics.md). A site opts in with
// manifest `sites.<site>.analytics: true`; the platform captures every request
// in the site runner (no IP, no raw UA, no cookie stored), keeps raw hits and
// daily rollups in the platform database, and answers query / live / csv.
// Always scoped to the calling app.
//
// One file per capability: see src/apps/capabilities.js and docs/capabilities.md.

const engine = () => require('../analytics');

function siteArg(p) {
  if (!p || typeof p.site !== 'string' || !p.site) throw new Error('site required');
  return p.site;
}
// { site, from, to, metrics, groupBy, filters, bots, scope, limit } → the query params
function paramsOf(p) {
  const { site, ...rest } = p || {};
  return rest;
}

module.exports = {
  key: 'analytics',
  title: 'Site analytics',
  core: false,
  gated: true,
  methods: ['analytics.query', 'analytics.live', 'analytics.csv'],
  prefixes: ['analytics.'],
  ctx: ['analytics'],
  keywords: /\b(analytics|page ?views?|visitors?|unique visitors|bounce rate|referrers?|utm|traffic stats|site statistics|access log)\b/i,
  summary: '`ctx.analytics` — site stats, no IPs stored',
  visibility: { standalone: false },
  revocable: true,

  buildCtx(app) {
    const name = app.name;
    const e = () => engine();
    const resolveFile = (f) => (require('path').isAbsolute(String(f || '')) ? String(f) : app.resolvePath(String(f || '')));
    return {
      analytics: {
        query: (p) => e().query(name, siteArg(p), paramsOf(p)),
        live: (site) => e().live(name, site),
        csv: (p) => e().csv(name, siteArg(p), paramsOf(p)),
        track: (site, eventName, props) => e().track(name, site, eventName, props),
        importAccessLog: (site, file, opts = {}) => e().importAccessLog(name, site, resolveFile(file), opts),
        status: (site) => e().status(name, site),
      },
    };
  },

  bridge: {
    'analytics.query': async (app, p) => engine().query(app.name, siteArg(p), paramsOf(p)),
    'analytics.live': async (app, p) => ({ live: await engine().live(app.name, siteArg(p)) }),
    'analytics.csv': async (app, p) => ({ csv: await engine().csv(app.name, siteArg(p), paramsOf(p)) }),
  },

  horst: {
    lane: {
      direct: { 'analytics.query': 'analytics_query', 'analytics.live': 'analytics_query', 'analytics.csv': 'analytics_query' },
      why: 'reading an app\'s site statistics is harmless; counting, retention and imports are the platform\'s and the app\'s own',
    },
    brief: 'analytics: privacy-friendly stats for apps\' own sites (visitors, pageviews, referrers, countries; no IPs stored) — analytics_query',
    tools: [
      {
        def: {
          name: 'analytics_query',
          description: 'Read-only. Site analytics of one app\'s site (opt-in per site): visitors, pageviews, hits, bounce rate and more, grouped by day, page, referrer, utm campaign, country, browser, os, device, language, status or event. Also the live visitor count (live:true).',
          inputSchema: { type: 'object', properties: {
            app: { type: 'string' },
            site: { type: 'string' },
            from: { type: 'string', description: 'YYYY-MM-DD (UTC), default 6 days before `to`' },
            to: { type: 'string', description: 'YYYY-MM-DD (UTC), default today' },
            metrics: { type: 'array', items: { type: 'string' }, description: 'visitors, pageviews, hits, events, bytes, errors, avgMs, bounces, bounceRate' },
            groupBy: { type: 'array', items: { type: 'string' }, description: 'day, hour, bot, path, referrer, utm_source, utm_medium, utm_campaign, country, browser, os, device, lang, status, event' },
            filters: { type: 'object', description: 'equality filters on the same dimensions (not day/hour/bot)' },
            live: { type: 'boolean', description: 'only the visitors of the last 5 minutes' },
          }, required: ['app', 'site'] },
        },
        handler: async (args) => {
          const { textResult } = require('../horst-facet');
          const e = engine();
          if (args.live) return textResult({ live: await e.live(args.app, args.site) });
          const { app, site, live, ...params } = args;
          return textResult(await e.query(app, site, params));
        },
      },
    ],
  },
};
