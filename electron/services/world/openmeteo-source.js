// ─────────────────────────────────────────────────────────────────────────
// WORLD AWARENESS · WEATHER source — Open-Meteo (free, no key, global).
//
// WorldMonitor has no forecast endpoint for Fred's bases (its climate data is
// US/ERA5 only), so weather is its own swappable source — exactly what the
// source-agnostic seam is for. Open-Meteo is free, unauthenticated, and takes
// raw coordinates, so it covers Naarden + Ibiza precisely. Returns a neutral
// shape the weather normalizer maps into a WorldRead. READ-ONLY.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

// Default bases; override with WORLD_WEATHER_LOCATIONS="Name:lat,lon;Name:lat,lon".
const DEFAULT_LOCATIONS = [
  { name: 'Naarden', lat: 52.2956, lon: 5.1606 },
  { name: 'Ibiza', lat: 38.9067, lon: 1.4206 },
];
function loadLocations() {
  const raw = process.env.WORLD_WEATHER_LOCATIONS;
  if (!raw) return DEFAULT_LOCATIONS;
  const out = [];
  for (const part of raw.split(';')) {
    const m = part.trim().match(/^(.+?):\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (m) out.push({ name: m[1].trim(), lat: Number(m[2]), lon: Number(m[3]) });
  }
  return out.length ? out : DEFAULT_LOCATIONS;
}

const TIMEOUT = Number(process.env.WORLD_WEATHER_TIMEOUT_MS || 8000);
const BASE = 'https://api.open-meteo.com/v1/forecast';

// WMO weather-code → short spoken description.
const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow',
  77: 'snow grains', 80: 'rain showers', 81: 'rain showers', 82: 'heavy showers',
  85: 'snow showers', 86: 'snow showers', 95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'severe thunderstorms',
};
function describe(code) { return WMO[code] || 'mixed conditions'; }

async function fetchOne(loc) {
  const url = new URL(BASE);
  url.searchParams.set('latitude', loc.lat);
  url.searchParams.set('longitude', loc.lon);
  url.searchParams.set('current', 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m');
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '1');
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const c = j.current || {}, d = j.daily || {};
  return {
    name: loc.name,
    tempC: typeof c.temperature_2m === 'number' ? c.temperature_2m : null,
    feelsC: typeof c.apparent_temperature === 'number' ? c.apparent_temperature : null,
    code: c.weather_code,
    desc: describe(c.weather_code),
    windKmh: typeof c.wind_speed_10m === 'number' ? c.wind_speed_10m : null,
    hiC: d.temperature_2m_max ? d.temperature_2m_max[0] : null,
    loC: d.temperature_2m_min ? d.temperature_2m_min[0] : null,
    rainProb: d.precipitation_probability_max ? d.precipitation_probability_max[0] : null,
  };
}

async function fetchWeather() {
  const locs = loadLocations();
  const results = await Promise.allSettled(locs.map(fetchOne));
  const places = [];
  const missing = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') places.push(r.value);
    else missing.push(locs[i].name);
  });
  return { places, missing: missing.length ? [`the forecast for ${missing.join(' and ')}`] : [], asOf: new Date().toISOString() };
}

module.exports = { fetchWeather, loadLocations };
