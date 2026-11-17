# Hannibal World Awareness — Multi-Topic Build Status

**Date:** 2026-06-09 · Built out from crypto-only (Stage 1) to the full topic set Fred chose
(markets, news, regional, weather, flights + free extras: energy, government, conflict).
Eyes = the WorldMonitor **desktop app**; ears = the GEX131 **self-host** (free feeds) + Open-Meteo (weather).

## What's wired (say any of these)
"What's happening with crypto / the markets / the news / the Middle East / Europe / Asia / energy /
the conflict situation?" · "energy update" · "the weather" · "how are the markets doing" · "world news".
The **Stage-2 router** resolves messy phrasing (regex fast-path → 70b fallback) and **gracefully declines**
untracked topics. All read-only; numbers are real or the feed is named as unreachable — never invented.

## Live right now (FREE, no key) — verified end-to-end
| Topic | Sample spoken line (live) | Source |
|---|---|---|
| **crypto** | "Crypto's quiet — BTC around $63.3k, ETH around $1,689, Cardano $0.17 (+5.1%), mood's neutral, stablecoins on peg." | WorldMonitor (CoinGecko/CoinPaprika) |
| **markets** | "Cardano is up 5.1% — BTC $63.3k (+0.7%), ETH $1,689 (+1.2%), oil $90 (-1.7%), mood's neutral." | + commodities (Yahoo) |
| **weather** | "Naarden 14°, partly cloudy, 100% rain; Ibiza 22°, partly cloudy." | **Open-Meteo direct** (your exact coords) |
| **regional** | "Here's the Middle East — posture: calm, recent fatalities 883." | regional snapshot + HAPI humanitarian |
| **energy** | "142 active energy-crisis policies in play — EU gas storage 42% full." | IEA / GIE (no key) |
| **government** | "US debt-to-GDP 129%, Venezuela heaviest at 309% of GDP." | IMF debt clock |
| **news** | "Top signal — SEC establishes joint data standards…" | cross-source signals (see GDELT note) |
| **conflict** | honest degrade today (needs the relay + ACLED key) | theater posture + events |
| **flights** | "No major flight delays right now." (FAA live; intl needs a key) | FAA |

**Feeds seeded on GEX131:** 78 no-key feeds populated + a **cron every 30 min** keeps them fresh
(`~/worldmonitor/hannibal-seed-nokey.sh`). Nothing here costs money.

## Two honest gaps (free, but blocked upstream — not our setup)
- **News headlines (GDELT):** GDELT returns **HTTP 429 (rate-limited)** to GEX131's datacenter IP — a known
  GDELT-vs-Hetzner-IP issue. News still works via the **cross-source-signals** stream (regulatory/market/conflict
  signals). Richer GDELT headlines would need the seed run from a different IP or via the relay.
- **Conflict "Security" + live aircraft/vessels:** need the **Railway relay** deployed (AISStream/OpenSky) — infra,
  not a key. Out of scope for the no-key pass; the conflict read degrades honestly until then.

---

## Your free-key signup list (≈10 min each) — unlocks the rest
Add each key on **GEX131** in `~/worldmonitor/docker-compose.override.yml` under `services: worldmonitor: environment:`,
then `docker compose up -d worldmonitor` and re-run that feed's seeder. **No Hannibal change needed** — the topics
already read these endpoints and will light up automatically once the data seeds.

| Key | Unlocks (topic) | Free tier | Sign up |
|---|---|---|---|
| **FINNHUB_API_KEY** | **markets** → stocks, indices, sectors, earnings | 60 req/min | https://finnhub.io |
| **EIA_API_KEY** | **energy** → live oil/gas prices, crude & natgas inventories | generous, free | https://www.eia.gov/opendata |
| **ACLED_EMAIL + ACLED_PASSWORD** | **conflict** → event-level conflict (the "C" in the U/C/S/I index) | free (researcher), auto-refresh | https://acleddata.com |
| **AVIATIONSTACK_API** | **flights** → full intl airport delays/ops (FAA already free) | ~100 req/mo (limited) | https://aviationstack.com |
| *(optional)* AGSI_API_KEY | energy → per-country EU gas detail | free | https://agsi.gie.eu |
| *(optional)* UCDP_ACCESS_TOKEN | conflict → UCDP violence events | free *(upstream 404 right now)* | https://ucdp.uu.se/apidocs |
| *(optional)* NASA_FIRMS_API_KEY | wildfires tile | free | https://firms.modaps.eosdis.nasa.gov |

Paste the keys to me when you have them and I'll wire them in + verify each topic goes from degraded → live.

## Architecture (the reusable seams)
`electron/services/world/`: `worldmonitor-source.js` (only file that knows WorldMonitor) +
`openmeteo-source.js` (weather) → `world-read.js` (per-topic normalizers, the judgement layer) →
`router.js` (Stage-2 topic router) → `world-narrator.js` (generic, number-validated 70b polish) →
`index.js` (dual-dispatch + IPC `world:read`). Catalog tool `world.read(topic)` is planner/executor-callable.
Adding a topic = one entry in `topics.js`. Eyes default = open the desktop app (`WORLD_EYES_MODE=browser` to use the dashboard).

**Still pending your live mic run** (say it, watch the app focus + hear the line). Read-only throughout; no write path.
