// ─────────────────────────────────────────────────────────────────────────
// WORLD AWARENESS · NORMALIZER (brief §3.2) — the reusable crown jewel.
//
// Maps each source-agnostic feed into the single internal WorldRead shape, and
// performs the JUDGEMENT (what leads, which few signals matter) so the narrator
// stays a pure phrasing layer. One normalizer per topic; all emit:
//
//   WorldRead { topic, headline:{text,mood}, signals[], detail[], asOf, sourceView, mood, missing }
//
// signals[] are pre-formatted & speakable: {label, value} ("BTC","around $62.9k")
// or {text} (a full clause). Real figures only — the narrator never invents.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { fmtPrice, fmtPct, fmtNum } = require('./world-narrator');

function wr(topic, headline, signals, extra = {}) {
  return {
    topic, headline, signals: signals.filter(Boolean),
    detail: extra.detail || [], asOf: extra.asOf || new Date().toISOString(),
    sourceView: extra.sourceView || null, mood: headline.mood, missing: extra.missing || [],
  };
}

// ── CRYPTO (Stage-1 parity) ──
const ANCHORS = ['BTC', 'ETH'];
function cryptoRead(feed) {
  const sig = [];
  for (const sym of ANCHORS) {
    const q = (feed.quotes || []).find((x) => x.symbol === sym);
    if (q) sig.push({ label: sym, value: `around ${fmtPrice(q.price)}` });
  }
  const movers = (feed.quotes || []).filter((q) => !ANCHORS.includes(q.symbol) && typeof q.change24h === 'number')
    .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h)).slice(0, 1).filter((q) => Math.abs(q.change24h) >= 5);
  for (const q of movers) sig.push({ label: q.name, value: `${fmtPrice(q.price)} (${fmtPct(q.change24h)})` });
  if (feed.sentiment) sig.push({ text: `mood's ${(feed.sentiment.label || '').toLowerCase()}` });
  let headline = { text: "crypto's quiet", mood: 'calm' };
  if (feed.stablecoins) {
    const depeg = feed.stablecoins.items.filter((c) => c.pegStatus && c.pegStatus !== 'ON PEG');
    if (depeg.length) headline = { text: `heads up — ${depeg[0].name || depeg[0].symbol} is off its peg at ${fmtPrice(depeg[0].price)}`, mood: 'notable' };
    else sig.push({ text: 'stablecoins on peg' });
  }
  if (headline.mood === 'calm' && feed.sentiment && typeof feed.sentiment.score === 'number') {
    if (feed.sentiment.score <= 25) headline = { text: 'crypto is in extreme fear', mood: 'notable' };
    else if (feed.sentiment.score >= 75) headline = { text: 'crypto is in extreme greed', mood: 'notable' };
  }
  return wr('crypto', headline, sig, { asOf: feed.asOf, missing: feed.missing });
}

// ── MARKETS (crypto + commodities + gold + mood) ──
function marketsRead(feed) {
  const sig = [];
  for (const sym of ANCHORS) {
    const q = (feed.crypto || []).find((x) => x.symbol === sym);
    if (q) sig.push({ label: sym, value: `${fmtPrice(q.price)}${typeof q.change24h === 'number' ? ` (${fmtPct(q.change24h)})` : ''}` });
  }
  const oil = (feed.commodities || []).find((c) => /CL=F|crude|oil|brent/i.test(`${c.symbol} ${c.name}`));
  if (oil) sig.push({ label: 'oil', value: `${fmtPrice(oil.price)}${typeof oil.change24h === 'number' ? ` (${fmtPct(oil.change24h)})` : ''}` });
  if (feed.goldPrice) sig.push({ label: 'gold', value: fmtPrice(feed.goldPrice) });
  if (feed.sentiment) sig.push({ text: `mood's ${(feed.sentiment.label || '').toLowerCase()}` });
  // lead with the biggest mover across crypto+commodities
  const all = [...(feed.crypto || []), ...(feed.commodities || [])].filter((q) => typeof q.change24h === 'number');
  const big = all.sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))[0];
  let headline = { text: 'markets are steady', mood: 'calm' };
  if (big && Math.abs(big.change24h) >= 4) headline = { text: `${big.name} is ${big.change24h >= 0 ? 'up' : 'down'} ${Math.abs(big.change24h).toFixed(1)}%`, mood: 'notable' };
  return wr('markets', headline, sig, { asOf: feed.asOf, missing: feed.missing });
}

// ── NEWS (GDELT headlines + cross-source signals) ──
function trimTitle(t) { return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 110); }
function newsRead(feed) {
  const sig = [];
  const top = (feed.articles || []).slice(0, 3);
  for (const a of top) sig.push({ text: `“${trimTitle(a.title)}”${a.source ? ` — ${a.source}` : ''}` });
  const signals = (feed.crossSignals || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0)).filter((s) => s.summary);
  let headline;
  if (top.length) {
    headline = { text: "here's what's leading the wire", mood: 'notable' };
    // top off with one cross-source signal if we only had one article
    if (sig.length < 2 && signals[0]) sig.push({ text: trimTitle(signals[0].summary) });
  } else if (signals.length) {
    // GDELT headline seed lagging → lead with the top cross-source signal, then
    // voice the NEXT ones (no duplication with the headline).
    headline = { text: `top signal — ${trimTitle(signals[0].summary)}`, mood: 'notable' };
    for (const s of signals.slice(1, 3)) sig.push({ text: trimTitle(s.summary) });
  } else {
    headline = { text: 'the news wire is quiet', mood: 'calm' };
  }
  const hasContent = top.length > 0 || signals.length > 0;
  const missing = hasContent ? (feed.missing || []).filter((m) => !/news wire/i.test(m)) : feed.missing;
  return wr('news', headline, sig, { asOf: feed.asOf, missing, detail: feed.articles });
}

// ── REGIONAL (snapshot + brief + humanitarian + headlines) ──
function regionalRead(feed, label) {
  const sig = [];
  const snap = feed.snapshot, brief = feed.brief;
  if (snap && snap.regime && snap.regime.label) sig.push({ text: `posture: ${String(snap.regime.label).toLowerCase()}` });
  const recap = brief && (brief.situationRecap || brief.situation_recap);
  const devs = brief && (brief.keyDevelopments || brief.key_developments);
  if (recap) sig.push({ text: trimTitle(recap) });
  else if (Array.isArray(devs) && devs[0]) sig.push({ text: trimTitle(typeof devs[0] === 'string' ? devs[0] : devs[0].title) });
  const fatalities = feed.humanitarian && (feed.humanitarian.conflictFatalities ?? feed.humanitarian.conflict_fatalities);
  if (typeof fatalities === 'number' && fatalities > 0) sig.push({ label: 'recent fatalities', value: fmtNum(fatalities) });
  for (const a of (feed.articles || []).slice(0, 2)) sig.push({ text: `“${trimTitle(a.title)}”` });
  const hasData = !!(snap || brief || (feed.articles || []).length);
  const headline = { text: hasData ? `here's ${label}` : `${label} desk is quiet`, mood: 'notable' };
  return wr(`regional:${feed.regionId}`, headline, sig, { asOf: feed.asOf, missing: feed.missing });
}

// ── ENERGY ──
function energyRead(feed) {
  const sig = [];
  const os = feed.oilStocks;
  if (os && (os.summary || os.global)) {
    const g = os.summary || os.global || {};
    if (typeof g.daysOfCover === 'number' || typeof g.days_of_cover === 'number') sig.push({ label: 'oil cover', value: `${fmtNum(g.daysOfCover ?? g.days_of_cover)} days` });
  }
  if (feed.euGas && (typeof feed.euGas.fillPct === 'number' || (feed.euGas.summary && typeof feed.euGas.summary.fillPct === 'number'))) {
    const f = feed.euGas.fillPct ?? feed.euGas.summary.fillPct;
    sig.push({ label: 'EU gas storage', value: `${Math.round(f)}% full` });
  }
  for (const p of (feed.prices || []).slice(0, 2)) sig.push({ label: p.name, value: `${fmtPrice(p.price)}${typeof p.change === 'number' ? ` (${fmtPct(p.change)})` : ''}` });
  const crisis = feed.crisis && (feed.crisis.policies || feed.crisis.entries || []);
  let headline = { text: 'energy markets are calm', mood: 'calm' };
  if (Array.isArray(crisis) && crisis.length) headline = { text: `${crisis.length} active energy-crisis ${crisis.length === 1 ? 'policy' : 'policies'} in play`, mood: 'notable' };
  else if (sig.length) headline = { text: "here's the energy picture", mood: 'calm' };
  return wr('energy', headline, sig, { asOf: feed.asOf, missing: feed.missing });
}

// ── GOVERNMENT (national debt) ──
function governmentRead(feed) {
  // Speak debt-to-GDP percentages (the clean, real figure); the absolute
  // debtUsd field is in a scaled unit, so we don't voice a dollar amount.
  const sig = [];
  const us = (feed.debt || []).find((e) => e.iso3 === 'USA');
  if (us && typeof us.debtToGdp === 'number') sig.push({ label: 'US debt-to-GDP', value: `${Math.round(us.debtToGdp)}%` });
  const top = (feed.debt || []).filter((e) => typeof e.debtToGdp === 'number' && e.iso3 !== 'USA').sort((a, b) => b.debtToGdp - a.debtToGdp)[0];
  if (top) sig.push({ text: `${top.iso3} carries the heaviest load at ${Math.round(top.debtToGdp)}% of GDP` });
  const headline = { text: sig.length ? "here's the government debt picture" : 'government desk is quiet', mood: 'calm' };
  return wr('government', headline, sig, { asOf: feed.asOf, missing: feed.missing });
}

// ── CONFLICT / SECURITY (theater posture + events) ──
function conflictRead(feed) {
  const sig = [];
  const hot = (feed.theaters || []).slice().sort((a, b) => (b.postureLevel || 0) - (a.postureLevel || 0));
  const lead = hot[0];
  for (const t of hot.slice(0, 2)) {
    const bits = [];
    if (t.activeFlights) bits.push(`${fmtNum(t.activeFlights)} mil flights`);
    if (t.trackedVessels) bits.push(`${fmtNum(t.trackedVessels)} vessels`);
    sig.push({ text: `${t.theater}${t.postureLevel ? ` posture ${t.postureLevel}` : ''}${bits.length ? ` (${bits.join(', ')})` : ''}` });
  }
  if (feed.ucdpEvents || feed.acledEvents) sig.push({ label: 'recent conflict events', value: fmtNum(feed.ucdpEvents + feed.acledEvents) });
  const topSig = (feed.crossSignals || [])[0];
  if (topSig && topSig.summary) sig.push({ text: trimTitle(topSig.summary) });
  let headline = { text: 'no major flashpoints right now', mood: 'calm' };
  if (lead && lead.postureLevel && /elevated|high|critical/i.test(String(lead.postureLevel))) headline = { text: `${lead.theater} is the hot theater (${lead.postureLevel})`, mood: 'notable' };
  else if (sig.length) headline = { text: "here's the security picture", mood: 'calm' };
  return wr('conflict', headline, sig, { asOf: feed.asOf, missing: feed.missing });
}

// ── WEATHER (Open-Meteo: Naarden + Ibiza) ──
function weatherRead(feed) {
  const sig = [];
  let notable = null;
  for (const p of feed.places || []) {
    const t = typeof p.tempC === 'number' ? `${Math.round(p.tempC)}°` : '';
    const rain = typeof p.rainProb === 'number' && p.rainProb >= 40 ? `, ${p.rainProb}% rain` : '';
    sig.push({ text: `${p.name} ${t}, ${p.desc}${rain}` });
    if (/storm|heavy|snow|freezing|severe/.test(p.desc) || (typeof p.rainProb === 'number' && p.rainProb >= 70)) notable = p;
    if (typeof p.tempC === 'number' && (p.tempC <= 0 || p.tempC >= 33)) notable = notable || p;
  }
  const headline = notable
    ? { text: `${notable.name} has ${notable.desc}${typeof notable.rainProb === 'number' && notable.rainProb >= 40 ? ` and ${notable.rainProb}% chance of rain` : ''}`, mood: 'notable' }
    : { text: "here's your weather", mood: 'calm' };
  return wr('weather', headline, sig, { asOf: feed.asOf, missing: feed.missing });
}

// ── FLIGHTS (airport delays) ──
function flightsRead(feed) {
  const sig = [];
  const worst = (feed.alerts || []).slice().sort((a, b) => (b.avgDelayMin || 0) - (a.avgDelayMin || 0));
  for (const a of worst.slice(0, 3)) {
    const d = typeof a.avgDelayMin === 'number' && a.avgDelayMin ? `, avg ${Math.round(a.avgDelayMin)} min` : '';
    sig.push({ text: `${a.city || a.iata}${a.iata ? ` (${a.iata})` : ''}${d}${a.reason ? ` — ${trimTitle(a.reason)}` : ''}` });
  }
  const headline = worst.length
    ? { text: `${worst.length} airport${worst.length === 1 ? '' : 's'} reporting delays`, mood: worst.length >= 5 ? 'notable' : 'calm' }
    : { text: 'no major flight delays right now', mood: 'calm' };
  return wr('flights', headline, sig, { asOf: feed.asOf, missing: feed.missing });
}

module.exports = {
  cryptoRead, marketsRead, newsRead, regionalRead, energyRead, governmentRead, conflictRead, weatherRead, flightsRead,
  // legacy Stage-1 name
  toWorldRead: cryptoRead,
};
