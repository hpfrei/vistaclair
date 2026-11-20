// Google Maps Platform for apps — Routes v2, Geocoding, Places (New), Street
// View Static. Backs the `maps` capability (ai.route/routeMatrix/geocode/
// places/placePhoto/streetview/tiles3d) and the
// matching ctx members. Key resolution mirrors translate: dedicated
// 'google-maps' provider key first, then the shared 'google' key — one GCP key
// can have all APIs enabled.

const spawnManager = require('./spawn-manager');
const { core } = require('./core-services');

function _mapsKey() {
  const apiKey = core.resolveProviderKey('google-maps') || core.resolveProviderKey('google-translate');
  if (!apiKey) throw new Error('Google Maps API key not configured. Add a Google Maps Platform key in Apps → AI Config, or set the Google Translate key (same GCP key can have Maps APIs enabled).');
  return apiKey;
}

// Accepts a waypoint as: address string, {lat, lng}, {latitude, longitude},
// {placeId}, or an already-shaped Routes API Waypoint object (passed through).
function _toWaypoint(v, label) {
  if (v == null) throw new Error(`${label} is required`);
  if (typeof v === 'string') return { address: v };
  if (typeof v !== 'object') throw new Error(`${label} must be an address string, {lat,lng}, or {placeId}`);
  if (v.placeId) return { placeId: v.placeId };
  const lat = v.lat ?? v.latitude;
  const lng = v.lng ?? v.lon ?? v.longitude;
  if (typeof lat === 'number' && typeof lng === 'number') {
    return { location: { latLng: { latitude: lat, longitude: lng } } };
  }
  if (v.address || v.location || v.via != null || v.vehicleStopover != null || v.sideOfRoad != null) return v;
  throw new Error(`${label} must be an address string, {lat,lng}, or {placeId}`);
}

async function _mapsFetch(url, { method = 'POST', apiKey, fieldMask, body, timeout, what }) {
  const headers = { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey };
  if (fieldMask) headers['X-Goog-FieldMask'] = fieldMask;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout || 30000),
    });
  } catch (err) {
    throw new Error(`${what} request failed: ${err.message}`);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let msg = '';
    try { msg = JSON.parse(errText)?.error?.message || ''; } catch {}
    throw new Error(`${what} failed (${res.status}): ${msg || errText.slice(0, 500) || res.statusText}`);
  }
  return res.json();
}

const ROUTE_FIELD_MASK = [
  'routes.duration', 'routes.staticDuration', 'routes.distanceMeters', 'routes.polyline',
  'routes.description', 'routes.warnings', 'routes.routeLabels', 'routes.viewport',
  'routes.localizedValues', 'routes.travelAdvisory',
  'routes.legs.duration', 'routes.legs.staticDuration', 'routes.legs.distanceMeters',
  'routes.legs.polyline', 'routes.legs.startLocation', 'routes.legs.endLocation',
  'routes.legs.localizedValues', 'routes.legs.travelAdvisory',
  'routes.legs.steps.staticDuration', 'routes.legs.steps.distanceMeters',
  'routes.legs.steps.navigationInstruction', 'routes.legs.steps.polyline',
  'routes.legs.steps.startLocation', 'routes.legs.steps.endLocation',
  'routes.legs.steps.travelMode', 'routes.legs.steps.transitDetails',
  'routes.legs.steps.localizedValues',
].join(',');

// Directions via the Google Routes API v2 (computeRoutes). Origin/destination/
// waypoints accept address strings, {lat,lng}, or {placeId}. All native request
// fields pass through; params.body merges raw fields for full API coverage.
async function aiRoute(appName, params) {
  const apiKey = _mapsKey();
  const p = params || {};

  const body = {
    origin: _toWaypoint(p.origin, 'origin'),
    destination: _toWaypoint(p.destination, 'destination'),
    travelMode: p.travelMode || 'DRIVE',
  };
  const intermediates = p.intermediates || p.waypoints;
  if (Array.isArray(intermediates) && intermediates.length) {
    body.intermediates = intermediates.map((w, i) => _toWaypoint(w, `waypoints[${i}]`));
  }
  for (const k of ['routingPreference', 'polylineQuality', 'polylineEncoding', 'departureTime',
    'arrivalTime', 'computeAlternativeRoutes', 'routeModifiers', 'languageCode', 'regionCode',
    'units', 'optimizeWaypointOrder', 'requestedReferenceRoutes', 'extraComputations',
    'trafficModel', 'transitPreferences']) {
    if (p[k] !== undefined) body[k] = p[k];
  }
  if (p.avoidTolls || p.avoidHighways || p.avoidFerries) {
    body.routeModifiers = Object.assign({}, body.routeModifiers,
      p.avoidTolls ? { avoidTolls: true } : null,
      p.avoidHighways ? { avoidHighways: true } : null,
      p.avoidFerries ? { avoidFerries: true } : null);
  }
  if (p.body && typeof p.body === 'object') Object.assign(body, p.body);

  const json = await _mapsFetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    apiKey, body, timeout: p.timeout, what: 'Route',
    fieldMask: p.fieldMask || ROUTE_FIELD_MASK,
  });
  return {
    routes: json.routes || [],
    fallbackInfo: json.fallbackInfo || null,
    geocodingResults: json.geocodingResults || null,
    instanceId: `${appName}-route-${spawnManager.currentId()}`,
  };
}

// Distance/duration matrix via the Routes API v2 (computeRouteMatrix).
// params.origins / params.destinations are arrays of waypoints (same shapes
// as aiRoute). Returns one element per origin×destination pair.
async function aiRouteMatrix(appName, params) {
  const apiKey = _mapsKey();
  const p = params || {};
  if (!Array.isArray(p.origins) || !p.origins.length) throw new Error('origins array is required');
  if (!Array.isArray(p.destinations) || !p.destinations.length) throw new Error('destinations array is required');

  const body = {
    origins: p.origins.map((w, i) => ({ waypoint: _toWaypoint(w, `origins[${i}]`) })),
    destinations: p.destinations.map((w, i) => ({ waypoint: _toWaypoint(w, `destinations[${i}]`) })),
    travelMode: p.travelMode || 'DRIVE',
  };
  for (const k of ['routingPreference', 'departureTime', 'arrivalTime', 'languageCode',
    'regionCode', 'units', 'extraComputations', 'trafficModel', 'transitPreferences']) {
    if (p[k] !== undefined) body[k] = p[k];
  }
  if (p.body && typeof p.body === 'object') Object.assign(body, p.body);

  const json = await _mapsFetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
    apiKey, body, timeout: p.timeout, what: 'Route matrix',
    fieldMask: p.fieldMask || 'originIndex,destinationIndex,status,condition,distanceMeters,duration,staticDuration,localizedValues',
  });
  // computeRouteMatrix returns a bare JSON array of elements.
  return { elements: Array.isArray(json) ? json : [], instanceId: `${appName}-routematrix-${spawnManager.currentId()}` };
}

// Forward geocoding (params.address) or reverse (params.lat/lng or
// params.latlng "lat,lng") via the Geocoding API.
async function aiGeocode(appName, params) {
  const apiKey = _mapsKey();
  const p = params || {};

  const q = new URLSearchParams({ key: apiKey });
  const lat = p.lat ?? p.latitude;
  const lng = p.lng ?? p.lon ?? p.longitude;
  if (p.address) q.set('address', String(p.address));
  else if (typeof lat === 'number' && typeof lng === 'number') q.set('latlng', `${lat},${lng}`);
  else if (typeof p.latlng === 'string') q.set('latlng', p.latlng);
  else if (p.placeId) q.set('place_id', p.placeId);
  else throw new Error('address (forward), lat/lng (reverse), or placeId is required');
  for (const k of ['language', 'region', 'components', 'bounds', 'result_type', 'location_type']) {
    if (p[k] !== undefined) q.set(k, String(p[k]));
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?${q}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(p.timeout || 30000) });
  } catch (err) {
    throw new Error(`Geocode request failed: ${err.message}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.status && json.status !== 'OK' && json.status !== 'ZERO_RESULTS')) {
    throw new Error(`Geocoding failed (${json.status || res.status}): ${json.error_message || res.statusText}`);
  }
  return { status: json.status, results: json.results || [], instanceId: `${appName}-geocode-${spawnManager.currentId()}` };
}

const PLACES_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours.openNow,places.websiteUri,places.internationalPhoneNumber';

// Places API (New). params.op selects the operation:
//   'search' (default) — text search, params.query
//   'nearby'           — params.lat/lng + radius (m), optional includedTypes
//   'details'          — params.placeId
//   'autocomplete'     — params.input
async function aiPlaces(appName, params) {
  const apiKey = _mapsKey();
  const p = params || {};
  const op = p.op || 'search';
  const timeout = p.timeout;

  if (op === 'search') {
    const query = p.query || p.textQuery;
    if (!query) throw new Error('query is required for places search');
    const body = { textQuery: String(query) };
    for (const k of ['languageCode', 'regionCode', 'includedType', 'openNow', 'minRating',
      'priceLevels', 'rankPreference', 'locationBias', 'locationRestriction', 'pageSize', 'pageToken']) {
      if (p[k] !== undefined) body[k] = p[k];
    }
    if (p.body && typeof p.body === 'object') Object.assign(body, p.body);
    const json = await _mapsFetch('https://places.googleapis.com/v1/places:searchText', {
      apiKey, body, timeout, what: 'Places search',
      fieldMask: p.fieldMask || `${PLACES_FIELD_MASK},nextPageToken`,
    });
    return { places: json.places || [], nextPageToken: json.nextPageToken || null, instanceId: `${appName}-places-${spawnManager.currentId()}` };
  }

  if (op === 'nearby') {
    const lat = p.lat ?? p.latitude;
    const lng = p.lng ?? p.lon ?? p.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') throw new Error('lat and lng are required for nearby search');
    const body = {
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: p.radius || 1000 } },
    };
    for (const k of ['includedTypes', 'excludedTypes', 'includedPrimaryTypes', 'excludedPrimaryTypes',
      'languageCode', 'regionCode', 'maxResultCount', 'rankPreference']) {
      if (p[k] !== undefined) body[k] = p[k];
    }
    if (p.body && typeof p.body === 'object') Object.assign(body, p.body);
    const json = await _mapsFetch('https://places.googleapis.com/v1/places:searchNearby', {
      apiKey, body, timeout, what: 'Places nearby search',
      fieldMask: p.fieldMask || PLACES_FIELD_MASK,
    });
    return { places: json.places || [], instanceId: `${appName}-places-${spawnManager.currentId()}` };
  }

  if (op === 'details') {
    if (!p.placeId) throw new Error('placeId is required for place details');
    const id = String(p.placeId).replace(/^places\//, '');
    const json = await _mapsFetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
      method: 'GET', apiKey, timeout, what: 'Place details',
      fieldMask: p.fieldMask || PLACES_FIELD_MASK.replace(/places\./g, '') + ',regularOpeningHours,editorialSummary,reviews',
    });
    return { place: json, instanceId: `${appName}-places-${spawnManager.currentId()}` };
  }

  if (op === 'autocomplete') {
    if (!p.input) throw new Error('input is required for autocomplete');
    const body = { input: String(p.input) };
    for (const k of ['languageCode', 'regionCode', 'includedPrimaryTypes', 'includedRegionCodes',
      'locationBias', 'locationRestriction', 'origin', 'sessionToken', 'includeQueryPredictions']) {
      if (p[k] !== undefined) body[k] = p[k];
    }
    if (p.body && typeof p.body === 'object') Object.assign(body, p.body);
    const json = await _mapsFetch('https://places.googleapis.com/v1/places:autocomplete', {
      apiKey, body, timeout, what: 'Places autocomplete',
    });
    return { suggestions: json.suggestions || [], instanceId: `${appName}-places-${spawnManager.currentId()}` };
  }

  throw new Error(`Unknown places op "${op}". Use search, nearby, details, or autocomplete.`);
}

// Classifies a Google Maps Platform error response body the same way
// translateDiagnose does. Never throws.
// Fetch a place photo as base64. params.name is the photo resource name from a
// places search/details response (e.g. "places/ChIJ.../photos/AUac...").
// Returns base64 bytes + mimeType + a ready-to-use dataUri, so the app can
// cache on disk or display directly. The googleusercontent redirect URI is
// short-lived; base64 is the durable contract.
async function aiPlacePhoto(appName, params) {
  const apiKey = _mapsKey();
  const p = params || {};
  if (!p.name) throw new Error('photo name is required (from places.photos[].name in a search/details response)');
  const q = new URLSearchParams({ key: apiKey });
  q.set('maxWidthPx', String(p.maxWidthPx || p.maxWidth || 800));
  if (p.maxHeightPx || p.maxHeight) q.set('maxHeightPx', String(p.maxHeightPx || p.maxHeight));
  const name = String(p.name).replace(/^\/+/, '');
  const url = `https://places.googleapis.com/v1/${name}/media?${q}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(p.timeout || 30000), redirect: 'follow' });
  } catch (err) {
    throw new Error(`Place photo request failed: ${err.message}`);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Place photo failed (${res.status}): ${errText.slice(0, 500) || res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get('content-type') || 'image/jpeg';
  const data = buf.toString('base64');
  return { data, mimeType, dataUri: `data:${mimeType};base64,${data}`, instanceId: `${appName}-placephoto-${spawnManager.currentId()}` };
}

// ---------------------------------------------------------------------------
// Street View Static API. Two operations on one method:
//   'metadata' (default) — /maps/api/streetview/metadata. FREE at Google, so
//                          it authorizes against the spend policy but settles
//                          nothing: an app checks coverage, pano id and pano
//                          date before paying for pixels.
//   'image'              — /maps/api/streetview. Billed per request.
// Places photos are user-contributed and carry no type, so an app cannot ask
// one for an EXTERIOR view. Street View is exterior by construction, and
// `source: 'outdoor'` is Google's own filter that drops indoor panoramas.
const SV_HOST = 'https://maps.googleapis.com';
const SV_MAX_PX = 640;          // Street View Static API's own size ceiling
const SV_DEFAULT_RADIUS = 50;   // metres to search around the coordinate

function _clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// A finite number from any of several spellings, else undefined.
function _num(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// `location` (lat,lng) or `pano` — the two ways to name a panorama. Shared by
// the metadata and image endpoints, which take identical selectors.
function _svSelector(p, q) {
  const pano = p.pano_id || p.panoId || p.pano;
  const lat = _num(p.lat, p.latitude);
  const lng = _num(p.lng, p.lon, p.longitude);
  if (pano) q.set('pano', String(pano));
  else if (lat !== undefined && lng !== undefined) q.set('location', `${lat},${lng}`);
  else throw new Error('lat/lng or pano_id is required');
  const radius = _num(p.radius);
  if (!pano) q.set('radius', String(radius === undefined ? SV_DEFAULT_RADIUS : Math.max(0, radius)));
  if (p.source) q.set('source', String(p.source));
  return q;
}

async function _svFetch(url, timeout, what) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeout || 30000) });
  } catch (err) {
    throw new Error(`${what} request failed: ${err.message}`);
  }
}

// The metadata endpoint answers 200 with a status string even when there is no
// coverage; only a transport/key failure is an exception.
async function _svMetadata(apiKey, p, timeout) {
  const q = _svSelector(p, new URLSearchParams({ key: apiKey }));
  const res = await _svFetch(`${SV_HOST}/maps/api/streetview/metadata?${q}`, timeout, 'Street View metadata');
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const c = _classifyMapsError(res.status, JSON.stringify(json));
    throw new Error(`Street View metadata failed (${res.status}): ${c.message}${c.state === 'api-disabled' ? ' — enable the Street View Static API on the Maps key' : ''}`);
  }
  if (json.status === 'REQUEST_DENIED' || json.status === 'OVER_QUERY_LIMIT') {
    throw new Error(`Street View metadata failed (${json.status}): ${json.error_message || 'check the Maps key and that the Street View Static API is enabled'}`);
  }
  return {
    status: json.status || 'UNKNOWN_ERROR',
    pano_id: json.pano_id || null,
    date: json.date || null,
    location: json.location ? { lat: json.location.lat, lng: json.location.lng } : null,
    copyright: json.copyright || null,
  };
}

// Street View. params.op selects the operation:
//   'metadata' (default) — coverage probe: { status, pano_id, date, location,
//                          copyright }. Free at Google, so it settles nothing.
//   'image'              — a JPEG of that panorama as base64.
// op 'image' resolves the pano through the free metadata endpoint FIRST, so a
// coordinate with no coverage costs nothing (the billed request is never made)
// and every image carries the `copyright` string Google's terms require on
// display — the image endpoint itself returns no attribution. The image is then
// requested by pano id, so the framing is deterministic.
async function aiStreetview(appName, params) {
  const apiKey = _mapsKey();
  const p = params || {};
  const op = p.op || 'metadata';
  const timeout = p.timeout;
  spendGate.authorize(appName, 'ai.streetview', { via: 'ctx', meterKey: p.meterKey });
  const instanceId = `${appName}-streetview-${spawnManager.currentId()}`;

  if (op === 'metadata') {
    return { ...(await _svMetadata(apiKey, p, timeout)), instanceId };
  }

  if (op === 'image') {
    const meta = await _svMetadata(apiKey, p, timeout);
    // No coverage is a status, not an exception and not a grey placeholder:
    // an app sweeping candidate camera points must be able to skip cheaply.
    if (meta.status !== 'OK' || !meta.pano_id) {
      return { ...meta, data: null, mimeType: null, dataUri: null, bytes: 0, billed: false, instanceId };
    }

    const width = _clamp(Math.round(_num(p.width, p.maxWidthPx) ?? SV_MAX_PX), 1, SV_MAX_PX);
    const height = _clamp(Math.round(_num(p.height, p.maxHeightPx) ?? SV_MAX_PX), 1, SV_MAX_PX);
    const q = new URLSearchParams({ key: apiKey, pano: meta.pano_id, size: `${width}x${height}`, return_error_code: 'true' });
    const heading = _num(p.heading);
    if (heading !== undefined) q.set('heading', String(((heading % 360) + 360) % 360));
    q.set('pitch', String(_clamp(_num(p.pitch) ?? 0, -90, 90)));
    q.set('fov', String(_clamp(_num(p.fov) ?? 90, 10, 120)));

    const res = await _svFetch(`${SV_HOST}/maps/api/streetview?${q}`, timeout, 'Street View image');
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      // return_error_code turns "no imagery here" into a 404 rather than a grey
      // tile — report it the same way the metadata probe would.
      if (res.status === 404) return { ...meta, status: 'ZERO_RESULTS', data: null, mimeType: null, dataUri: null, bytes: 0, billed: false, instanceId };
      const c = _classifyMapsError(res.status, errText);
      throw new Error(`Street View image failed (${res.status}): ${c.message}${c.state === 'api-disabled' ? ' — enable the Street View Static API on the Maps key' : ''}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get('content-type') || 'image/jpeg';
    const data = buf.toString('base64');
    try { spendGate.settle(appName, 'ai.streetview', { units: 1, meterKey: p.meterKey }); } catch {}
    return {
      ...meta, data, mimeType, dataUri: `data:${mimeType};base64,${data}`,
      bytes: buf.length, width, height, billed: true, instanceId,
    };
  }

  throw new Error(`Unknown streetview op "${op}". Use metadata or image.`);
}

// ---------------------------------------------------------------------------
// Photorealistic 3D Tiles (Map Tiles API). Google bills the ROOT tileset
// request only (one per ~3 h session, Enterprise SKU); every child tileset
// and .glb fetched with that session's token is free. So the root is cached
// process-wide for the session window and shared by every app — one billed
// event serves the whole platform for hours. Tile fetches are authorized
// against the spend policy (a revoked app cannot pull tiles) but settle
// nothing.
const TILES_HOST = 'https://tile.googleapis.com';
const TILES_ROOT_PATH = '/v1/3dtiles/root.json';
const TILES_PREFIX = '/v1/3dtiles/';
const TILES_ROOT_TTL_MS = 150 * 60 * 1000;   // session lasts >= 3 h; re-root at 2.5 h
let _tilesRoot = null;                        // { key, tileset, session, fetchedAt }

// The session token rides inside every child URI the root returns
// (".../files/XXX.json?session=TOKEN"); there is no separate field for it.
function _tilesSession(tileset) {
  const m = JSON.stringify(tileset).match(/[?&]session=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// glTF binary header: magic 'glTF' | version | length | chunk0 length |
// chunk0 type 'JSON' | JSON bytes. asset.copyright is the attribution string
// the Map Tiles policy requires renderers to show (semicolon-separated).
function _glbAsset(buf) {
  if (!buf || buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) return null;
  const len = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a || 20 + len > buf.length) return null;
  try { return JSON.parse(buf.subarray(20, 20 + len).toString('utf8')).asset || null; } catch { return null; }
}

function _cacheMeta(res) {
  const cc = res.headers.get('cache-control') || '';
  const m = cc.match(/max-age=(\d+)/);
  return { maxAge: m ? Number(m[1]) : null, etag: res.headers.get('etag') || null, cacheControl: cc || null };
}

async function _tilesRootFetch(apiKey, timeout) {
  let res;
  try {
    res = await fetch(`${TILES_HOST}${TILES_ROOT_PATH}?key=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(timeout || 30000),
    });
  } catch (err) {
    throw new Error(`3D Tiles root request failed: ${err.message}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const c = _classifyMapsError(res.status, text);
    throw new Error(`3D Tiles root failed (${res.status}): ${c.message}${c.state === 'api-disabled' ? ' — enable the Map Tiles API on the Maps key' : ''}`);
  }
  let tileset;
  try { tileset = JSON.parse(text); } catch { throw new Error('3D Tiles root returned no JSON'); }
  const session = _tilesSession(tileset);
  if (!session) throw new Error('3D Tiles root carried no session token');
  _tilesRoot = { key: apiKey, tileset, session, fetchedAt: Date.now() };
  return _tilesRoot;
}

function _tilesRootValid(apiKey) {
  return _tilesRoot && _tilesRoot.key === apiKey && Date.now() - _tilesRoot.fetchedAt < TILES_ROOT_TTL_MS;
}

// Photorealistic 3D Tiles. params.op selects the operation:
//   'root'  (default) — the root tileset.json. Cached per key for the session
//                       window; `fresh: true` forces a new (billed) root.
//   'fetch'           — one child tileset (.json) or tile (.glb) by the
//                       relative `uri` a tileset lists (content.uri /
//                       children[].content.uri, session token included).
// The API key never leaves the platform: URIs are validated to the 3D Tiles
// path prefix and the key is appended here. Cache headers are passed back so
// the caller can honour max-age / ETag as the Map Tiles policy requires.
async function aiTiles3d(appName, params) {
  const apiKey = _mapsKey();
  const p = params || {};
  const op = p.op || 'root';
  const timeout = p.timeout || 60000;
  spendGate.authorize(appName, 'ai.tiles3d', { via: 'ctx', meterKey: p.meterKey });
  const instanceId = `${appName}-tiles3d-${spawnManager.currentId()}`;

  if (op === 'root') {
    let billed = false;
    if (p.fresh || !_tilesRootValid(apiKey)) {
      await _tilesRootFetch(apiKey, timeout);
      billed = true;
      try { spendGate.settle(appName, 'ai.tiles3d', { units: 1, meterKey: p.meterKey }); } catch {}
    }
    return {
      tileset: _tilesRoot.tileset, session: _tilesRoot.session,
      expiresAt: new Date(_tilesRoot.fetchedAt + TILES_ROOT_TTL_MS).toISOString(),
      cached: !billed, billed, instanceId,
    };
  }

  if (op === 'fetch') {
    if (!p.uri || typeof p.uri !== 'string') throw new Error('uri is required (a content.uri from a 3D Tiles tileset)');
    let u;
    try { u = new URL(p.uri, TILES_HOST); } catch { throw new Error('uri is not a valid 3D Tiles URI'); }
    if (u.origin !== TILES_HOST || !u.pathname.startsWith(TILES_PREFIX) || u.pathname === TILES_ROOT_PATH) {
      throw new Error(`uri must be a relative 3D Tiles path (${TILES_PREFIX}...) from a tileset; got ${p.uri.slice(0, 120)}`);
    }
    u.searchParams.delete('key');
    if (!u.searchParams.get('session')) {
      if (!_tilesRootValid(apiKey)) throw new Error('uri carries no session token and no 3D Tiles session is open — call op "root" first');
      u.searchParams.set('session', _tilesRoot.session);
    }
    u.searchParams.set('key', apiKey);
    let res;
    try {
      res = await fetch(u.toString(), { signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      throw new Error(`3D Tiles fetch failed: ${err.message}`);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const c = _classifyMapsError(res.status, errText);
      // a rejected session token means the 3 h window closed early: drop the
      // cached root so the next 'root' call re-roots instead of re-failing
      if (res.status === 400 || res.status === 403 || res.status === 404) _tilesRoot = null;
      throw new Error(`3D Tiles fetch failed (${res.status}): ${c.message} — if the session expired, call op "root" again`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get('content-type') || '';
    const meta = _cacheMeta(res);
    const isJson = /json/i.test(mimeType) || /\.json(\?|$)/.test(u.pathname);
    if (isJson) {
      let json;
      try { json = JSON.parse(buf.toString('utf8')); } catch { throw new Error('3D Tiles tileset returned no JSON'); }
      return { kind: 'tileset', json, bytes: buf.length, ...meta, instanceId };
    }
    const asset = _glbAsset(buf);
    return {
      kind: 'glb', data: buf.toString('base64'), mimeType: mimeType || 'model/gltf-binary',
      bytes: buf.length, copyright: (asset && asset.copyright) || null,
      generator: (asset && asset.generator) || null, ...meta, instanceId,
    };
  }

  throw new Error(`Unknown tiles3d op "${op}". Use root or fetch.`);
}

function _classifyMapsError(status, text) {
  let err = {};
  try { err = JSON.parse(text)?.error || {}; } catch {}
  const detail = (err.details || []).find((d) => d.reason) || {};
  const reason = detail.reason || (err.errors && err.errors[0] && err.errors[0].reason) || '';
  const project = detail.metadata?.consumer?.replace(/^projects\//, '') || null;
  const message = err.message || `HTTP ${status}`;
  let state = 'error';
  if (status === 403 && (reason === 'API_KEY_SERVICE_BLOCKED' || reason === 'API_KEY_HTTP_REFERRER_BLOCKED' || reason === 'API_KEY_IP_ADDRESS_BLOCKED' || reason === 'API_KEY_API_TARGET_BLOCKED')) state = 'key-restricted';
  else if (status === 403 && reason === 'SERVICE_DISABLED') state = 'api-disabled';
  else if ((status === 400 || status === 403) && (reason === 'API_KEY_INVALID' || /API key not valid/i.test(message))) state = 'invalid-key';
  else if (status === 403 && /billing/i.test(message)) state = 'billing';
  return { state, status, reason, project, message };
}

// Live diagnostic for the Google Maps Platform setup. Probes Routes, Geocoding,
// and Places with minimal requests and reports a per-API state so the UI can
// show exactly which APIs still need enabling. Never throws.
async function mapsDiagnose() {
  const dedicated = !!core.resolveProviderKey('google-maps');
  const apiKey = core.resolveProviderKey('google-maps') || core.resolveProviderKey('google-translate');
  const source = dedicated ? 'google-maps' : (core.resolveProviderKey('google-translate') ? 'google-translate' : null);
  if (!apiKey) return { state: 'no-key', source: null, apis: {} };

  const probes = {
    routes: async () => fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'routes.distanceMeters' },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: 52.5162, longitude: 13.3777 } } },
        destination: { location: { latLng: { latitude: 52.52, longitude: 13.405 } } },
        travelMode: 'DRIVE',
      }),
      signal: AbortSignal.timeout(15000),
    }),
    geocoding: async () => fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=Berlin&key=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(15000),
    }),
    places: async () => fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id' },
      body: JSON.stringify({ textQuery: 'Berlin', pageSize: 1 }),
      signal: AbortSignal.timeout(15000),
    }),
    // The metadata endpoint is free, so probing Street View costs nothing.
    streetview: async () => fetch(`${SV_HOST}/maps/api/streetview/metadata?location=52.5162,13.3777&key=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(15000),
    }),
  };

  const apis = {};
  let project = null;
  // Map Tiles API (3D Tiles): the root request IS the billed unit, so a live
  // cached root answers without spending and a fresh probe seeds the cache.
  if (_tilesRootValid(apiKey)) apis.tiles3d = { state: 'ok', cached: true };
  else {
    try {
      await _tilesRootFetch(apiKey, 15000);
      apis.tiles3d = { state: 'ok' };
    } catch (err) {
      const m = /\((\d{3})\)/.exec(err.message);
      const status = m ? Number(m[1]) : 0;
      const state = /enable the Map Tiles API|SERVICE_DISABLED|not enabled|disabled/i.test(err.message) ? 'api-disabled'
        : /blocked|restricted/i.test(err.message) ? 'key-restricted'
        : /not valid|invalid/i.test(err.message) ? 'invalid-key'
        : /billing/i.test(err.message) ? 'billing' : 'error';
      apis.tiles3d = { state, status, message: err.message };
    }
  }
  for (const [api, probe] of Object.entries(probes)) {
    try {
      const res = await probe();
      const text = await res.text();
      if (res.ok) {
        // Geocoding and Street View return 200 with an error status in the body.
        let bodyStatus = '', bodyErr = '';
        try { const j = JSON.parse(text); bodyStatus = j.status || ''; bodyErr = j.error_message || ''; } catch {}
        if ((api === 'geocoding' || api === 'streetview') && bodyStatus === 'REQUEST_DENIED') {
          const state = /not authorized|API_KEY_SERVICE_BLOCKED|restricted/i.test(bodyErr) ? 'key-restricted'
            : /not activated|disabled/i.test(bodyErr) ? 'api-disabled'
            : /billing/i.test(bodyErr) ? 'billing'
            : /invalid/i.test(bodyErr) ? 'invalid-key' : 'error';
          apis[api] = { state, message: bodyErr || bodyStatus };
        } else {
          apis[api] = { state: 'ok' };
        }
      } else {
        const c = _classifyMapsError(res.status, text);
        apis[api] = { state: c.state, reason: c.reason, message: c.message };
        if (c.project) project = c.project;
      }
    } catch (err) {
      apis[api] = { state: 'error', message: `Could not reach Google: ${err.message}` };
    }
  }

  const states = Object.values(apis).map((a) => a.state);
  const overall = states.every((s) => s === 'ok') ? 'ok'
    : states.includes('ok') ? 'partial'
    : states.find((s) => s !== 'ok') || 'error';
  return { state: overall, source, project, apis };
}

const spendGate = require('./spend-gate');
module.exports = {
  aiRoute: spendGate.wrap('ai.route', aiRoute, () => 1),
  aiRouteMatrix: spendGate.wrap('ai.routeMatrix', aiRouteMatrix, () => 1),
  aiGeocode: spendGate.wrap('ai.geocode', aiGeocode, () => 1),
  aiPlaces: spendGate.wrap('ai.places', aiPlaces, () => 1),
  aiPlacePhoto: spendGate.wrap('ai.placePhoto', aiPlacePhoto, () => 1),
  aiStreetview,         // authorizes itself; metadata is free, only an image settles
  aiTiles3d,            // authorizes itself; settles only a billed root request
  mapsDiagnose,
};
