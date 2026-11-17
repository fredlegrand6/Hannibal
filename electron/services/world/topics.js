// ─────────────────────────────────────────────────────────────────────────
// WORLD AWARENESS · TOPIC REGISTRY — the Stage-2/3 seam.
//
// Each topic binds: a spoken-name matcher (fast path for the router), the EYES
// view to open, and a build() that fetches → normalizes → a WorldRead. Adding a
// topic is one entry here, not a rebuild (brief §3.3 / Stage 3 "by config").
//
// EYES: default opens the WorldMonitor DESKTOP APP (the diagnosis verdict —
// app = eyes, self-host = ears). Override per env WORLD_EYES_MODE=browser to
// open the browser dashboard URL instead.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const src = require('./worldmonitor-source');
const weather = require('./openmeteo-source');
const norm = require('./world-read');

const BASE = (process.env.WORLDMONITOR_BASE_URL || 'http://100.99.70.113:3000').replace(/\/+$/, '');
const EYES_MODE = process.env.WORLD_EYES_MODE || 'app';            // 'app' | 'browser'
const DESKTOP_APP = process.env.WORLD_DESKTOP_APP || 'World Monitor';

// A view descriptor the dual-dispatcher resolves into an open action.
function view(urlBrowser) {
  return EYES_MODE === 'browser'
    ? { kind: 'url', url: urlBrowser || `${BASE}/` }
    : { kind: 'app', app: DESKTOP_APP, fallbackUrl: urlBrowser || `${BASE}/` };
}

// Regions for the regional topic — spoken name → WorldMonitor region_id + an
// ISO-2 country hint for the humanitarian summary. Unknown region_id still
// yields GDELT headlines for the region words (graceful).
const REGIONS = [
  { key: 'middle-east', label: 'the Middle East', region_id: 'mena', cc: 'IR', match: /\b(middle east|mena|gulf|levant)\b/ },
  { key: 'europe', label: 'Europe', region_id: 'europe', cc: 'UA', match: /\b(europe|european|eu)\b/ },
  { key: 'asia-pacific', label: 'Asia-Pacific', region_id: 'east-asia', cc: 'CN', match: /\b(asia|asia[- ]?pacific|apac|east asia|indo[- ]?pacific|pacific)\b/ },
  { key: 'africa', label: 'Africa', region_id: 'africa', cc: 'SD', match: /\b(africa|african|sahel)\b/ },
  { key: 'latin-america', label: 'Latin America', region_id: 'latam', cc: 'VE', match: /\b(latin america|latam|south america|central america)\b/ },
  { key: 'us', label: 'the US', region_id: 'north-america', cc: 'US', match: /\b(the us|u\.s\.|united states|america|north america)\b/ },
];

const TOPICS = [
  { key: 'crypto', label: 'crypto', match: /\bcrypto(currency)?\b|\bbitcoin\b|\bethereum\b/,
    view: () => view(`${BASE}/?variant=finance`),
    build: async () => norm.cryptoRead(await src.fetchCrypto()) },

  { key: 'markets', label: 'the markets', match: /\b(markets?|stocks?|equities|wall street|s&p|nasdaq|dow|commodities|gold|oil price)\b/,
    view: () => view(`${BASE}/?variant=finance`),
    build: async () => norm.marketsRead(await src.fetchMarkets()) },

  { key: 'news', label: 'the news', match: /\b(news|world news|headlines|what'?s going on in the world|the world)\b/,
    view: () => view(`${BASE}/`),
    build: async () => norm.newsRead(await src.fetchNews('world')) },

  { key: 'energy', label: 'energy', match: /\b(energy|power grid|electricity|gas storage|oil (supply|stocks)|fuel)\b/,
    view: () => view(`${BASE}/?variant=energy`),
    build: async () => norm.energyRead(await src.fetchEnergy()) },

  { key: 'government', label: 'government', match: /\b(government|regulatory|national debt|debt clock|treasury|fiscal)\b/,
    view: () => view(`${BASE}/`),
    build: async () => norm.governmentRead(await src.fetchGovernment()) },

  { key: 'conflict', label: 'conflict', match: /\b(conflict|war|wars|military|security|flashpoints?|tensions?|theater|geopolitic)/,
    view: () => view(`${BASE}/`),
    build: async () => norm.conflictRead(await src.fetchConflict()) },

  { key: 'flights', label: 'flights', match: /\b(flights?|aviation|airport|air travel|delays?)\b/,
    view: () => view(`${BASE}/`),
    build: async () => norm.flightsRead(await src.fetchFlights()) },

  { key: 'weather', label: 'the weather', match: /\b(weather|forecast|rain|temperature|hot|cold)\b/,
    view: () => view(`${BASE}/`),
    build: async () => norm.weatherRead(await weather.fetchWeather()) },
];

// Regional topic — resolved with the matched region.
function regionalTopic(region) {
  return {
    key: `regional:${region.key}`, label: region.label,
    view: () => view(`${BASE}/`),
    build: async () => norm.regionalRead(await src.fetchRegional(region.region_id, region.cc), region.label),
  };
}

// Fast-path matcher: returns a resolved topic (with build/view) or null.
function matchTopic(text) {
  const t = String(text || '').toLowerCase();
  // regional first (more specific place names) — but only when a region word is present
  for (const r of REGIONS) if (r.match.test(t)) return regionalTopic(r);
  for (const tp of TOPICS) if (tp.match.test(t)) return tp;
  return null;
}

function topicKeys() {
  return [...TOPICS.map((t) => t.label), ...REGIONS.map((r) => r.label)];
}

module.exports = { TOPICS, REGIONS, regionalTopic, matchTopic, topicKeys, view };
