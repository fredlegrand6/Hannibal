// ─────────────────────────────────────────────────────────────────────────
// WORLD AWARENESS · DATA SOURCE adapter — WorldMonitor (self-hosted on GEX131)
//
// The ONLY file in Hannibal that knows WorldMonitor exists: base URL, auth
// header, and the exact RPC paths (all discovered — see WORLDMONITOR_ENDPOINTS.md,
// never invented). Exposes a generic `wmGet()` plus one neutral fetcher per topic.
// Everything downstream consumes the neutral shapes; swap this file to swap source.
//
// AGPL boundary: data consumed over HTTP only; no WorldMonitor code vendored.
// READ-ONLY: GET requests only, no write path.
//
// KEY/NO-KEY: feeds that need a free-signup key (Finnhub stocks, EIA energy,
// ACLED/UCDP conflict, AviationStack flights) degrade gracefully — a 401/empty
// just marks that slice `missing`, and the narrator says so. No fabrication.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const BASE = (process.env.WORLDMONITOR_BASE_URL || 'http://100.99.70.113:3000').replace(/\/+$/, '');
const KEY = process.env.WORLDMONITOR_KEY || '';
const TIMEOUT = Number(process.env.WORLDMONITOR_TIMEOUT_MS || 9000);

async function wmGet(path, params) {
  const url = new URL(BASE + path);
  if (params) for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.set(k, String(v));
  }
  const headers = { Accept: 'application/json' };
  if (KEY) headers['X-WorldMonitor-Key'] = KEY;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
// settle helper: never throws, returns null on failure
async function tryGet(path, params) { try { return await wmGet(path, params); } catch (_) { return null; } }

// ───────────────────────── MARKETS / CRYPTO ─────────────────────────
function parseQuotes(j) {
  return (((j && j.quotes) || [])
    .filter((q) => q && q.symbol && typeof q.price === 'number')
    .map((q) => ({ name: q.name || q.symbol, symbol: String(q.symbol).toUpperCase(), price: q.price, change24h: typeof q.change === 'number' ? q.change : null })));
}
function parseSentiment(j) {
  if (!j || j.unavailable) return null;
  const score = typeof j.compositeScore === 'number' ? j.compositeScore : null;
  const label = (j.compositeLabel || '').trim();
  return (score == null && !label) ? null : { score, label: label || null, asOf: j.seededAt || null };
}
function parseStablecoins(j) {
  if (!j || !j.summary) return null;
  const s = j.summary;
  return {
    count: s.coinCount ?? 0, depeggedCount: s.depeggedCount ?? 0, healthStatus: s.healthStatus || null,
    items: ((j.stablecoins) || []).map((c) => ({ symbol: String(c.symbol || '').toUpperCase(), name: c.name || c.symbol, price: typeof c.price === 'number' ? c.price : null, pegStatus: c.pegStatus || null, deviation: typeof c.deviation === 'number' ? c.deviation : null })),
    asOf: j.timestamp || null,
  };
}

async function fetchCrypto() {
  const [q, fg, sc] = await Promise.all([tryGet('/api/market/v1/list-crypto-quotes'), tryGet('/api/market/v1/get-fear-greed-index'), tryGet('/api/market/v1/list-stablecoin-markets')]);
  const quotes = parseQuotes(q), sentiment = parseSentiment(fg), stablecoins = parseStablecoins(sc);
  const missing = [];
  if (!quotes.length) missing.push('crypto prices');
  if (!sentiment) missing.push('the mood gauge');
  if (!stablecoins) missing.push('stablecoin peg data');
  return { quotes, sentiment, stablecoins, missing, asOf: (sentiment && sentiment.asOf) || (stablecoins && stablecoins.asOf) || new Date().toISOString() };
}

async function fetchMarkets() {
  const [q, fg, comm, gold] = await Promise.all([
    tryGet('/api/market/v1/list-crypto-quotes'),
    tryGet('/api/market/v1/get-fear-greed-index'),
    tryGet('/api/market/v1/list-commodity-quotes', { symbols: ['CL=F', 'BZ=F', 'GC=F', 'NG=F'] }), // WTI/Brent/gold/natgas (no key); param required
    tryGet('/api/market/v1/get-gold-intelligence'),   // no key
  ]);
  const COMMODITY_NAMES = { 'CL=F': 'WTI crude', 'BZ=F': 'Brent crude', 'GC=F': 'gold', 'NG=F': 'natural gas', 'SI=F': 'silver' };
  const crypto = parseQuotes(q);
  const commodities = (((comm && comm.quotes) || []).filter((c) => c && c.symbol && typeof c.price === 'number')
    .map((c) => ({ name: COMMODITY_NAMES[c.symbol] || c.name || c.symbol, symbol: c.symbol, price: c.price, change24h: typeof c.change === 'number' ? c.change : null })));
  const sentiment = parseSentiment(fg);
  let goldPrice = null;
  if (gold && typeof gold.spotUsd === 'number') goldPrice = gold.spotUsd;
  else if (gold && gold.spot && typeof gold.spot.usd === 'number') goldPrice = gold.spot.usd;
  const missing = [];
  if (!crypto.length) missing.push('crypto');
  if (!commodities.length) missing.push('commodities');
  return { crypto, commodities, sentiment, goldPrice, missing, asOf: new Date().toISOString() };
}

// ───────────────────────── NEWS (GDELT, no key) ─────────────────────────
async function fetchNews(query = 'world') {
  const [docs, signals] = await Promise.all([
    tryGet('/api/intelligence/v1/search-gdelt-documents', { query, max_records: 25, sort: 'datedesc' }),
    tryGet('/api/intelligence/v1/list-cross-source-signals'),
  ]);
  const articles = (((docs && docs.articles) || []).map((a) => ({ title: a.title, source: a.source || a.domain, url: a.url, date: a.date, tone: typeof a.tone === 'number' ? a.tone : null })).filter((a) => a.title));
  const crossSignals = (((signals && signals.signals) || []).map((s) => ({ type: s.type, theater: s.theater, summary: s.summary, severity: s.severity, score: s.severityScore })));
  const missing = [];
  if (!articles.length) missing.push('the news wire');
  return { query, articles, crossSignals, missing, asOf: new Date().toISOString() };
}

// ───────────────────────── REGIONAL (seeded snapshots/briefs) ─────────────────────────
async function fetchRegional(regionId, countryCode) {
  const [snap, brief, human, news] = await Promise.all([
    tryGet('/api/intelligence/v1/get-regional-snapshot', { region_id: regionId }),
    tryGet('/api/intelligence/v1/get-regional-brief', { region_id: regionId }),
    countryCode ? tryGet('/api/conflict/v1/get-humanitarian-summary', { country_code: countryCode }) : Promise.resolve(null),
    tryGet('/api/intelligence/v1/search-gdelt-documents', { query: regionId.replace(/-/g, ' '), max_records: 12, sort: 'datedesc' }),
  ]);
  const snapshot = (snap && snap.snapshot) || null;
  const briefObj = (brief && brief.brief) || null;
  const humanitarian = (human && human.summary) || null;
  const articles = (((news && news.articles) || []).map((a) => ({ title: a.title, source: a.source || a.domain })).filter((a) => a.title)).slice(0, 6);
  const missing = [];
  if (!snapshot && !briefObj && !articles.length) missing.push(`the ${regionId.replace(/-/g, ' ')} desk`);
  return { regionId, snapshot, brief: briefObj, humanitarian, articles, missing, asOf: (snapshot && snapshot.generated_at) || new Date().toISOString() };
}

// ───────────────────────── ENERGY ─────────────────────────
async function fetchEnergy() {
  const [oilStocks, crisis, prices, euGas] = await Promise.all([
    tryGet('/api/economic/v1/get-oil-stocks-analysis'),   // IEA, no key
    tryGet('/api/economic/v1/get-energy-crisis-policies'), // no key
    tryGet('/api/economic/v1/get-energy-prices'),          // EIA key (degrades)
    tryGet('/api/economic/v1/get-eu-gas-storage'),         // GIE key (degrades)
  ]);
  const pricesArr = (((prices && prices.prices) || []).map((p) => ({ commodity: p.commodity, name: p.name || p.commodity, price: p.price, unit: p.unit, change: typeof p.change === 'number' ? p.change : null })));
  const missing = [];
  if (!pricesArr.length) missing.push('live energy prices (needs EIA key)');
  return { oilStocks: oilStocks || null, crisis: crisis || null, prices: pricesArr, euGas: euGas || null, missing, asOf: new Date().toISOString() };
}

// ───────────────────────── GOVERNMENT (national debt) ─────────────────────────
async function fetchGovernment() {
  const debt = await tryGet('/api/economic/v1/get-national-debt');
  const entries = (((debt && debt.entries) || []).map((e) => ({ iso3: e.iso3, debtUsd: e.debtUsd, gdpUsd: e.gdpUsd, debtToGdp: e.debtToGdp, perSecond: e.perSecondRate })));
  const missing = [];
  if (!entries.length) missing.push('the debt clock');
  return { debt: entries, missing, asOf: new Date().toISOString() };
}

// ───────────────────────── CONFLICT / SECURITY (CII composite) ─────────────────────────
async function fetchConflict(theater = '') {
  const [posture, ucdp, acled, signals] = await Promise.all([
    tryGet('/api/military/v1/get-theater-posture', theater ? { theater } : undefined),
    tryGet('/api/conflict/v1/list-ucdp-events', { page_size: 50 }),   // UCDP key + upstream (degrades)
    tryGet('/api/conflict/v1/list-acled-events', { page_size: 50 }),  // ACLED key (degrades)
    tryGet('/api/intelligence/v1/list-cross-source-signals'),
  ]);
  const theaters = (((posture && posture.theaters) || []).map((t) => ({ theater: t.theater, postureLevel: t.postureLevel, activeFlights: t.activeFlights, trackedVessels: t.trackedVessels, ops: (t.activeOperations || []).length })));
  const ucdpEvents = ((ucdp && ucdp.events) || []).length;
  const acledEvents = ((acled && acled.events) || []).length;
  const crossSignals = (((signals && signals.signals) || []).map((s) => ({ type: s.type, theater: s.theater, summary: s.summary, severity: s.severity })));
  const missing = [];
  if (!theaters.length) missing.push('theater posture (needs the relay)');
  if (!ucdpEvents && !acledEvents) missing.push('event-level conflict data (needs ACLED/UCDP key)');
  return { theaters, ucdpEvents, acledEvents, crossSignals, missing, asOf: new Date().toISOString() };
}

// ───────────────────────── FLIGHTS (FAA free; AviationStack degrades) ─────────────────────────
async function fetchFlights() {
  const delays = await tryGet('/api/aviation/v1/list-airport-delays', { page_size: 60 });
  // Keep only airports actually reporting a delay — drop the "Coverage unavailable"
  // placeholder rows the FAA-only feed returns (real intl coverage needs AviationStack).
  const all = ((delays && delays.alerts) || []).map((a) => ({
    iata: a.iata, name: a.name, city: a.city, country: a.country,
    severity: a.severity, avgDelayMin: a.avgDelayMinutes, cancelled: a.cancelledFlights,
    reason: a.reason, real: (a.avgDelayMinutes > 0) || (a.cancelledFlights > 0) || (a.severity && !/UNKNOWN|UNSPECIFIED/.test(a.severity)),
  }));
  const alerts = all.filter((a) => a.real);
  const placeholders = all.length - alerts.length;
  const missing = [];
  if (!alerts.length) missing.push(placeholders ? 'live delays (FAA shows no active delays; full intl coverage needs the AviationStack key)' : 'flight-delay data (needs the AviationStack key)');
  return { alerts, missing, asOf: new Date().toISOString() };
}

module.exports = {
  wmGet, tryGet,
  fetchCrypto, fetchMarkets, fetchNews, fetchRegional, fetchEnergy, fetchGovernment, fetchConflict, fetchFlights,
  BASE, KEY,
};
