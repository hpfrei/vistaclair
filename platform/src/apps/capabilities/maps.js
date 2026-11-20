// Capability: maps — `ai.route`, `ai.routeMatrix`, `ai.geocode`, `ai.places`, `ai.streetview`, `ai.tiles3d` (Google directions/matrix/geocoding/place search/Street View/Photorealistic 3D Tiles)
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

module.exports = {
  key: 'maps',
  title: 'Maps & Routing',
  core: false,
  gated: true,
  cost: 'metered',
  revocable: true,
  audiences: ['owner', 'user'],
  spend: { service: 'maps-service', units: { 'ai.route': 'request', 'ai.routeMatrix': 'request', 'ai.geocode': 'request', 'ai.places': 'request', 'ai.placePhoto': 'request', 'ai.streetview': 'request', 'ai.tiles3d': 'request' } },
  methods: ['ai.route', 'ai.routeMatrix', 'ai.geocode', 'ai.places', 'ai.placePhoto', 'ai.streetview', 'ai.tiles3d'],
  impliedBy: ['ai'],
  aliases: ['route', 'places'],
  runtime: ['getRoute', 'getRouteMatrix', 'geocode', 'findPlaces', 'getPlacePhoto', 'getStreetView', 'get3dTiles'],
  ctx: ['route', 'routeMatrix', 'geocode', 'places', 'placePhoto', 'streetview', 'tiles3d'],
  keywords: /\b(rout(e|es|ing)|directions|navigation|geocod|places?|address(es)?|map|distance matrix|eta|travel time|itinerar|waypoint|lat\/?lng|coordinates|3d tiles|tileset|photorealistic|street ?view|panorama|facade|fa\u00e7ade|exterior photo)\b/i,
  summary: '`ai.route/geocode/places/streetview/tiles3d` — Google maps, tiles',
  migration: 'Google Maps/Directions/Distance Matrix/Geocoding/Places called via `http.fetch` with an app-held key → `ai.route` / `ai.routeMatrix` / `ai.geocode` / `ai.places`. Remove the app\'s own Maps key.',

  buildCtx(app) {
    const maps = require('../maps-service');
    const name = app.name;
    // Google Maps Platform: routing (Routes API v2), geocoding, place search.
    // Key comes from the platform secrets store ('google-maps' or shared
    // 'google'). See _api-reference.md "Maps & Routing".
    return {
      route: (params) => maps.aiRoute(name, params),
      routeMatrix: (params) => maps.aiRouteMatrix(name, params),
      geocode: (params) => maps.aiGeocode(name, params),
      places: (params) => maps.aiPlaces(name, params),
      placePhoto: (params) => maps.aiPlacePhoto(name, params),
      streetview: (params) => maps.aiStreetview(name, params),
      tiles3d: (params) => maps.aiTiles3d(name, params),
    };
  },

  bridge: {
    'ai.route': (app, params) => require('../maps-service').aiRoute(app.name, params),
    'ai.routeMatrix': (app, params) => require('../maps-service').aiRouteMatrix(app.name, params),
    'ai.geocode': (app, params) => require('../maps-service').aiGeocode(app.name, params),
    'ai.places': (app, params) => require('../maps-service').aiPlaces(app.name, params),
    'ai.placePhoto': (app, params) => require('../maps-service').aiPlacePhoto(app.name, params),
    'ai.streetview': (app, params) => require('../maps-service').aiStreetview(app.name, params),
    'ai.tiles3d': (app, params) => require('../maps-service').aiTiles3d(app.name, params),
  },

  // ---- Horst facet: routes, addresses, places, direct --------------------------
  // The same maps-service calls apps make, as appName 'platform' (Horst's
  // spend profile). Answers are trimmed to what a chat reply needs.
  horst: {
    brief: 'maps: travel time and distance between places (maps_route), addresses ↔ coordinates (maps_geocode), find places (maps_places)',
    lane: {
      direct: {
        'ai.route': 'maps_route',
        'ai.geocode': 'maps_geocode',
        'ai.places': 'maps_places',
        'ai.routeMatrix': { deferred: 'many-to-many planning is an app\'s; maps_route answers the owner\'s trip questions' },
        'ai.placePhoto': { deferred: 'place pictures have no chat request behind them yet; maps_places names the place' },
        'ai.streetview': { deferred: 'a façade picture has no chat request behind it yet' },
      },
      never: ['ai.tiles3d'],
      why: 'ai.tiles3d hands a 3D-tiles session to a WebGL renderer; Horst has none',
    },
    tools: [
      {
        def: {
          name: 'maps_route',
          description: 'Travel time and distance from one place to another (address, "lat,lng" or place id), by car, on foot, by bike or transit, optionally leaving at a given time. Metered (ai.route, platform spend policy). Returns duration, distance and the route summary per alternative.',
          inputSchema: {
            type: 'object',
            properties: {
              origin: { type: 'string' },
              destination: { type: 'string' },
              travelMode: { type: 'string', enum: ['DRIVE', 'WALK', 'BICYCLE', 'TRANSIT', 'TWO_WHEELER'] },
              departureTime: { type: 'string', description: 'RFC 3339, e.g. 2026-10-22T08:00:00Z' },
              alternatives: { type: 'boolean' },
            },
            required: ['origin', 'destination'],
          },
        },
        handler: async (args) => {
          const f = require('../horst-facet');
          const params = { origin: f.req(args || {}, 'origin'), destination: f.req(args, 'destination'), travelMode: args.travelMode || 'DRIVE' };
          if (args.departureTime) params.departureTime = args.departureTime;
          if (args.alternatives) params.computeAlternativeRoutes = true;
          if (params.travelMode === 'DRIVE' || params.travelMode === 'TWO_WHEELER') params.routingPreference = 'TRAFFIC_AWARE';
          return f.spendSafe(async () => {
            const r = await require('../maps-service').aiRoute('platform', params);
            if (!r.routes.length) return f.emptyResult('No route found.');
            return f.textResult(r.routes.map((x) => ({
              duration: (x.localizedValues && x.localizedValues.duration && x.localizedValues.duration.text) || x.duration,
              distance: (x.localizedValues && x.localizedValues.distance && x.localizedValues.distance.text) || x.distanceMeters,
              via: x.description || null,
              warnings: x.warnings || undefined,
            })));
          });
        },
      },
      {
        def: {
          name: 'maps_geocode',
          description: 'An address → its coordinates and formatted form, or "lat,lng" → the address there. Metered (ai.geocode, platform spend policy).',
          inputSchema: {
            type: 'object',
            properties: { address: { type: 'string' }, latlng: { type: 'string', description: '"lat,lng" for a reverse lookup' } },
          },
        },
        handler: async (args) => {
          const f = require('../horst-facet');
          const params = args && args.address ? { address: args.address } : { latlng: f.req(args || {}, 'latlng') };
          return f.spendSafe(async () => {
            const r = await require('../maps-service').aiGeocode('platform', params);
            if (!r.results.length) return f.emptyResult('No match.');
            return f.textResult(r.results.slice(0, 5).map((x) => ({ address: x.formatted_address, location: x.geometry && x.geometry.location, placeId: x.place_id })));
          });
        },
      },
      {
        def: {
          name: 'maps_places',
          description: 'Find places by a text query ("pharmacy near Alexanderplatz", "Café Einstein Berlin"): name, address, rating, open now, website, phone. Metered (ai.places, platform spend policy).',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'number', description: '1-10, default 5' } },
            required: ['query'],
          },
        },
        handler: async (args) => {
          const f = require('../horst-facet');
          const query = f.req(args || {}, 'query');
          return f.spendSafe(async () => {
            const r = await require('../maps-service').aiPlaces('platform', { op: 'search', query, pageSize: f.limitOf(args.limit, 5, 10) });
            if (!r.places.length) return f.emptyResult('No places found.');
            return f.textResult(r.places.slice(0, f.limitOf(args.limit, 5, 10)).map((p) => ({
              name: p.displayName && p.displayName.text, address: p.formattedAddress, rating: p.rating, ratings: p.userRatingCount,
              openNow: p.currentOpeningHours ? p.currentOpeningHours.openNow : undefined, website: p.websiteUri, phone: p.internationalPhoneNumber, id: p.id,
            })));
          });
        },
      },
    ],
  },
};
