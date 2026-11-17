# WorldMonitor — Endpoint Discovery (Hannibal World Awareness · Stage 0)

**Date:** 2026-06-09 · **Author:** Claude Code (for Fred Legrand)
**Self-hosted on:** GEX131 (Hetzner Helsinki) · Tailscale node `gex131-1` = `100.99.70.113`
**Reached over Tailscale at:** `http://100.99.70.113:3000` ✅ (verified loading from the Mac across the mesh)
**Source repo (on GEX131, NOT on the Mac):** `~/worldmonitor` — `git clone https://github.com/koala73/worldmonitor.git`
**License:** **AGPL-3.0-only** — this instance is consumed as an external DATA source only. No WorldMonitor code is copied/vendored/adapted into Hannibal (per brief §2.1).

> Stage 0 deliverable. **Nothing is wired into Hannibal.** This documents the *real, discovered* endpoint paths (from the running instance + its protobuf service definitions) and real sample payloads. Paths were read from `proto/` service definitions and the `[rpc].ts` gateways — **none invented**.

---

## 0. TL;DR

- WorldMonitor is **not** a simple "Ollama app." It is a **Vite SPA + a Node API (50+ protobuf RPC handlers) + Redis (seeded cache) + an AIS relay**, run via **Docker Compose** (`docker compose up -d --build`). The brief's `npm run dev` / port `5173` assumption does not apply to this app — `vite` alone serves only the SPA shell with no data backend. The app's real port is **3000** (nginx → Node API on 8080 inside the container; published `0.0.0.0:3000`, so Tailscale-reachable automatically).
- **GPU / VRAM: no competition.** WorldMonitor pulls **no Ollama models** and does not touch the GPU on its own. LLM use is **optional** ("intelligence assessments" only) via an OpenAI-compatible `LLM_API_URL` / `GROQ_API_KEY` / `OPENROUTER_API_KEY`. Left dark. GEX131's RTX PRO 6000 (98 GB) is untouched by this stack. (See §6.)
- **Crypto/finance view → `MarketService`** at base path **`/api/market/v1`** (19 GET RPCs).
- **Regional/geopolitical view → `ConflictService`** at base path **`/api/conflict/v1`** (5 RPCs, 4 GET + 1 POST).
- **Auth gate is real:** every data RPC requires a token. Three accepted forms; for Hannibal (machine-to-machine) use an **enterprise key** via header `X-WorldMonitor-Key`. See §3.
- ✅ **Clean API path is LIVE (§5):** the API's SSRF guard had blocked its own fetch to the private `redis-rest` host (seeded RPCs returned empty; `/api/health` = `REDIS_DOWN`). **Resolved** with a surgical, GEX131-only patch that allowlists *only* the configured Redis origin. Crypto/finance + regional RPCs now serve live data through the clean API with the `X-WorldMonitor-Key` header. Fred has confirmed live crypto data. **No patch in `~/hannibal-v2`.**

---

## 1. How it was stood up on GEX131

```bash
# On GEX131 (fred@gex131-1), NOT on the Mac:
# Node installed user-level via nvm (no root): node v24.16.0, npm 11  (apt had no nodejs; no passwordless sudo)
git clone https://github.com/koala73/worldmonitor.git ~/worldmonitor && cd ~/worldmonitor

# Required secrets (SELF_HOSTING.md): without these a container exits on boot
printf 'RELAY_SHARED_SECRET=%s\nREDIS_PASSWORD=%s\nREDIS_TOKEN=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env

# Auth secrets added via docker-compose.override.yml (gitignored) — see §3:
#   WM_SESSION_SECRET        -> lets the browser dashboard mint anonymous sessions
#   WORLDMONITOR_VALID_KEYS  -> stable machine key for Hannibal (X-WorldMonitor-Key)

docker compose up -d --build         # docker present, fred in docker group (no sudo needed)
./scripts/run-seeders.sh             # fills Redis (host-side seeders; key-free feeds work without API keys)
```

**Containers running:** `worldmonitor` (nginx+Node, `0.0.0.0:3000->8080`), `worldmonitor-redis`, `worldmonitor-redis-rest` (`127.0.0.1:8079`), `worldmonitor-ais-relay` (restarting — needs `AISSTREAM_API_KEY`; vessel feed intentionally left dark per brief).

**Tailscale binding:** Docker publishes `3000` on `0.0.0.0`, so it is reachable at `100.99.70.113:3000` with no extra `--host` flag. Verified: `curl http://100.99.70.113:3000/` from the Mac → `HTTP 200, 34957 bytes`.

---

## 2. The two views → two protobuf services

WorldMonitor's data layer is **sebuf/Connect-style protobuf RPC over HTTP GET/POST**. Each "view" maps to one service with a fixed base path. Routers: `api/market/v1/[rpc].ts` and `api/conflict/v1/[rpc].ts`. Method→path mapping comes from each `service.proto`'s `sebuf.http.config`.

### 2.1 Crypto / Finance view → `MarketService` — base `/api/market/v1`

| RPC | Method | Path | Data source | Key? |
|---|---|---|---|---|
| **ListCryptoQuotes** | GET | `/api/market/v1/list-crypto-quotes` | CoinGecko/CoinPaprika (seeded) | no |
| ListMarketQuotes | GET | `/api/market/v1/list-market-quotes` | Finnhub + Yahoo (seeded) | Finnhub for full |
| ListCommodityQuotes | GET | `/api/market/v1/list-commodity-quotes` | Yahoo Finance | no |
| GetSectorSummary | GET | `/api/market/v1/get-sector-summary` | Finnhub | Finnhub |
| **ListStablecoinMarkets** | GET | `/api/market/v1/list-stablecoin-markets` | CoinGecko (seeded) | no |
| ListEtfFlows | GET | `/api/market/v1/list-etf-flows` | Yahoo (BTC spot ETFs) | no |
| GetCountryStockIndex | GET | `/api/market/v1/get-country-stock-index` | Yahoo | no |
| ListGulfQuotes | GET | `/api/market/v1/list-gulf-quotes` | Yahoo (GCC) | no |
| ListCryptoSectors | GET | `/api/market/v1/list-crypto-sectors` | seeded | no |
| ListDefiTokens | GET | `/api/market/v1/list-defi-tokens` | seeded | no |
| ListAiTokens | GET | `/api/market/v1/list-ai-tokens` | seeded | no |
| ListOtherTokens | GET | `/api/market/v1/list-other-tokens` | seeded | no |
| **GetFearGreedIndex** | GET | `/api/market/v1/get-fear-greed-index` | composite (seeded) | no |
| ListEarningsCalendar | GET | `/api/market/v1/list-earnings-calendar` | Finnhub | Finnhub |
| GetCotPositioning | GET | `/api/market/v1/get-cot-positioning` | CFTC COT | no |
| GetInsiderTransactions | GET | `/api/market/v1/get-insider-transactions` | Finnhub (SEC) | Finnhub |
| GetMarketBreadthHistory | GET | `/api/market/v1/get-market-breadth-history` | seeded | no |
| GetGoldIntelligence | GET | `/api/market/v1/get-gold-intelligence` | XAU + CFTC | no |
| GetHyperliquidFlow | GET | `/api/market/v1/get-hyperliquid-flow` | Hyperliquid | no |

(Premium/account-only RPCs also exist: `analyze-stock`, `backtest-stock`, `get-stock-analysis-history`, `list-stored-stock-backtests`.)

**Adjacent finance feed (not in MarketService, useful for the broad view):** Prediction markets — `GET /api/polymarket` (Polymarket Gamma, public, no key), seeded under Redis `prediction:markets-bootstrap:v1` with `geopolitical[] / tech[] / finance[]` buckets.

### 2.2 Regional / Geopolitical view → `ConflictService` — base `/api/conflict/v1`

| RPC | Method | Path | Data source | Key? |
|---|---|---|---|---|
| **ListAcledEvents** | GET | `/api/conflict/v1/list-acled-events` | ACLED dataset (seeded) | `ACLED_ACCESS_TOKEN` |
| **ListUcdpEvents** | GET | `/api/conflict/v1/list-ucdp-events` | UCDP GED (seeded) | no |
| GetHumanitarianSummary | GET | `/api/conflict/v1/get-humanitarian-summary` | HAPI/HDX | no |
| **ListIranEvents** | GET | `/api/conflict/v1/list-iran-events` | LiveUAMap Iran (scrape) | no |
| GetHumanitarianSummaryBatch | **POST** | `/api/conflict/v1/get-humanitarian-summary-batch` | HAPI/HDX | no |

> "Middle East" (the brief's Stage-2 target) maps to this service: `list-iran-events` (LiveUAMap Iran), `list-acled-events?country=IL|IR|…`, `list-ucdp-events?country=…`, and `get-humanitarian-summary?country_code=…`.

---

## 3. Auth model (important for Hannibal wiring)

All `/api/*/v1/*` data RPCs return `401 {"error":"API key required"}` with no credential. Accepted forms (`api/_api-key.js`):

1. **Anonymous session token** — `POST /api/wm-session` issues an HMAC-signed `wms_…` cookie. This is what the **browser dashboard** uses. Requires server env `WM_SESSION_SECRET` (≥32 chars) — without it, `/api/wm-session` returns `503 {"error":"Session service not configured"}`. **Configured on this instance**, so the dashboard loads in a browser.
2. **User API key** — `wm_…` validated against the user-key table.
3. **Enterprise key** — any value in server env `WORLDMONITOR_VALID_KEYS` (comma-separated), passed as header **`X-WorldMonitor-Key:`** (or `X-Api-Key:`). **This is the right one for Hannibal** (stable, no cookie dance).

This instance's override (`~/worldmonitor/docker-compose.override.yml`, gitignored) sets both `WM_SESSION_SECRET` and `WORLDMONITOR_VALID_KEYS`. The Hannibal machine key value is stored on GEX131 at `~/worldmonitor/.. /tmp/wm-hannibal-key.txt` (regenerate/rotate before Stage 1 wiring; do not commit it).

```bash
# Machine call shape Hannibal will use (once §5 is resolved):
curl -H "X-WorldMonitor-Key: <key>" \
  "http://100.99.70.113:3000/api/market/v1/list-crypto-quotes"
```

---

## 4. Real sample responses — **live through the clean API**

> Captured from the running instance via the clean HTTP API with the machine key header, post-patch (§5). Numbers are live as of the seed run `2026-06-09T04:02Z`. Every call below is the literal shape Hannibal's `world-read` normalizer will consume.
>
> **Call shape (all market/conflict RPCs):**
> ```bash
> curl -H "X-WorldMonitor-Key: <key>" \
>   "http://100.99.70.113:3000/api/market/v1/list-crypto-quotes"
> ```

### `GET /api/market/v1/list-crypto-quotes` → `ListCryptoQuotesResponse`  ·  **HTTP 200, live**
Request query: `ids` (repeated CoinGecko IDs; empty = default set). Response: `{ quotes: CryptoQuote[] }` where `CryptoQuote = {name, symbol, price, change /*24h %*/, sparkline[], change7d}`.
```json
{"quotes":[
  {"name":"Bitcoin","symbol":"BTC","price":62850.75,"change":0.15},
  {"name":"Ethereum","symbol":"ETH","price":1668.69,"change":0.66},
  {"name":"BNB","symbol":"BNB","price":599.35,"change":0.39},
  {"name":"Solana","symbol":"SOL","price":65.96,"change":0.75},
  {"name":"XRP","symbol":"XRP","price":1.15,"change":1.14},
  {"name":"Cardano","symbol":"ADA","price":0.17,"change":2.63},
  {"name":"Dogecoin","symbol":"DOGE","price":0.09,"change":0.18},
  {"name":"TRON","symbol":"TRX","price":0.33,"change":-0.56},
  {"name":"Avalanche","symbol":"AVAX","price":6.66,"change":1.05},
  {"name":"Chainlink","symbol":"LINK","price":7.86,"change":1.00}
]}
```

### `GET /api/market/v1/get-fear-greed-index` → `GetFearGreedIndexResponse`  ·  **HTTP 200, live**
Request: empty. Response: `{compositeScore, compositeLabel, previousScore, seededAt, sentiment|volatility|positioning|trend|breadth|momentum|liquidity|credit|macro|cross_asset: FearGreedCategory{score,weight,contribution,degraded,inputsJson}, vix, hy_spread, yield_10y, …}`. Live served data:
```json
{"compositeScore":53.8,"compositeLabel":"Neutral","previousScore":0,
 "seededAt":"2026-06-09T04:02:59.672Z",
 "sentiment":{"score":40,"weight":0.1,"contribution":4,"degraded":true,
   "inputsJson":"{\"cnnFearGreed\":40,\"aaiBull\":null,\"aaiBear\":null,\"cryptoFg\":null}"},
 "volatility":{"score":70,"weight":0.1,"contribution":7,"degraded":false,
   "inputsJson":"{\"vix\":18.92,\"vix9d\":19.69,\"vix3m\":20.79,\"termStructure\":\"contango\"}"}}
```

### `GET /api/market/v1/list-stablecoin-markets` → `ListStablecoinMarketsResponse`  ·  **HTTP 200, live**
```json
{"timestamp":"2026-06-09T04:02:59.966Z",
 "summary":{"totalMarketCap":271870782820,"totalVolume24h":73502397409,
            "coinCount":5,"depeggedCount":0,"healthStatus":"HEALTHY"},
 "stablecoins":[
   {"id":"tether","symbol":"USDT","name":"Tether","price":0.999485,"deviation":0.052,
    "pegStatus":"ON PEG","marketCap":186863268265,"volume24h":58293966336,
    "change24h":0.00617,"change7d":0.1039},
   {"id":"usd-coin","symbol":"USDC","name":"USDC","price":0.99963,"deviation":0.037,
    "pegStatus":"ON PEG","marketCap":75959496988,"volume24h":14868968254,
    "change24h":-0.00021,"change7d":-0.0012}
 ]}
```

### `GET /api/polymarket` (prediction markets — broad/geopolitical) → buckets `geopolitical[] / tech[] / finance[]`
`PredictionMarket = {title, yesPrice, volume, url, endDate, tags[], source, regions[]}`. Real served data:
```json
{"geopolitical":[
  {"title":"Trump out as President before 2027?","yesPrice":10.5,"volume":8977478.96,
   "url":"https://polymarket.com/event/trump-out-as-president-before-2027",
   "endDate":"2026-12-31T00:00:00Z","tags":["elections","politics","geopolitics","trump"],
   "source":"polymarket","regions":["america"]},
  {"title":"Will the Iranian regime fall before 2027?","yesPrice":12.5,"volume":19543707.14,
   "url":"https://polymarket.com/event/will-the-iranian-regime-fall-by-the-end-of-2026",
   "endDate":"2026-12-31T00:00:00Z",
   "tags":["israel","iran","trump","middle-east","politics","iranian-leadership-regime"],
   "source":"polymarket","regions":[]}
]}
```

### Regional — `GET /api/conflict/v1/get-humanitarian-summary?country_code=IR` → `GetHumanitarianSummaryResponse`  ·  **HTTP 200, LIVE (no key, clean API)**
Request query: `country_code` (required, exactly 2 uppercase letters). Live served data (HAPI/HDX), captured while ais-relay was crash-looping — proving ConflictService is independent of it (§5b):
```json
{"summary":{"countryCode":"IR","countryName":"Iran (Islamic Republic of)",
  "conflictEventsTotal":2206,"conflictPoliticalViolenceEvents":1549,
  "conflictFatalities":883,"conflictDemonstrations":657,
  "referencePeriod":"2026-03-01T00:00:00","updatedAt":1780979725604}}
```

### Regional — `GET /api/conflict/v1/list-ucdp-events` → `ListUcdpEventsResponse`  ·  HTTP 200 (empty — upstream)
Request query: `start`,`end` (epoch ms), `page_size` (1–100), `cursor`, `country` (ISO-2). Response:
```jsonc
{"events":[
  {"id":"...", "date_start": 0, "date_end": 0,
   "location": {"lat": 0, "lon": 0}, "country":"...",
   "side_a":"...", "side_b":"...",
   "deaths_best": 0, "deaths_low": 0, "deaths_high": 0,
   "violence_type":"UCDP_VIOLENCE_TYPE_STATE_BASED|NON_STATE|ONE_SIDED",
   "source_original":"..."}
 ],
 "pagination": {"next_cursor":"", "has_more": false}}
```
*HTTP 200 with empty `events[]` at capture time: the UCDP GED upstream returned "No valid UCDP GED version found" (upstream-side, not our setup or the relay); schema above is authoritative from `proto/.../ucdp_event.proto`. Re-run `scripts/seed-ucdp-events.mjs` when the upstream version is restored.*

### Regional — `GET /api/conflict/v1/list-acled-events` → `ListAcledEventsResponse`
Request query: same filter set (`start`,`end`,`page_size`,`cursor`,`country`). `AcledConflictEvent = {id, event_type, country, location:{lat,lon}, occurred_at /*epoch ms*/, fatalities, actors[], source, admin1}`. **Requires `ACLED_ACCESS_TOKEN`** to populate (free for researchers; left dark — note for Fred).

### Regional — `GET /api/conflict/v1/list-iran-events` → `ListIranEventsResponse`
Request: empty. `IranEvent = {id, title, category, source_url, latitude, longitude, location_name, timestamp, severity}`, plus top-level `scraped_at`. *(LiveUAMap scrape returned "failed gracefully" at capture time — source-side rate/anti-scrape; no key needed.)*

*(`GetHumanitarianSummary` live sample is shown at the top of this regional block.)*

---

## 5. SSRF→Redis: resolved via surgical patch (clean API path)

**Was:** every seeded RPC returned empty (`{"quotes":[]}`, `{"events":[]}`, fear-greed `unavailable:true`) and `GET /api/health` → `{"status":"REDIS_DOWN"}`, **even though Redis was populated correctly.**

**Root cause:** the Docker container runs `src-tauri/sidecar/local-api-server.mjs`, which monkey-patches `globalThis.fetch` with an SSRF filter that blocks any URL resolving to a private/reserved IP. The app reads Redis via `fetch("http://redis-rest:80/get/…")`; `redis-rest` resolves to the Docker-internal `172.19.0.x` (RFC1918) → blocked. The blocklist also covers `100.64.0.0/10` (Tailscale CGNAT) and loopback, so there was no "just repoint the URL" fix; there is no env var to widen the allowlist.

**Fix (chosen path — clean API, not direct-Redis):** a **surgical, GEX131-only** patch that registers **only** the operator-configured Redis origin into the *existing* allowlist. At server startup, just before `registerSidecarAllowedPrivateFetchOrigins(boundPort, extraAllowedPrivateOrigins)`, we push `new URL(process.env.UPSTASH_REDIS_REST_URL).origin` into `extraAllowedPrivateOrigins`. This reuses the framework's own allowlist mechanism and exempts exactly one origin — `http://redis-rest` — **not** a blanket private-network bypass. All other SSRF protection (RSS/HLS proxies, etc.) is unchanged.

**Where the patch lives (and where it does NOT):**
- Host source: `~/worldmonitor/src-tauri/sidecar/local-api-server.mjs` on **GEX131 only** (original backed up to `…mjs.orig-stage0bak`). Marked with comment `[Hannibal Stage-0 patch — GEX131 WM instance ONLY]`.
- Mounted into the container read-only via `~/worldmonitor/docker-compose.override.yml`:
  `./src-tauri/sidecar/local-api-server.mjs:/app/local-api-server.mjs:ro` (survives restarts; no full image rebuild).
- **Nothing in `~/hannibal-v2`.** No WorldMonitor code is copied into Hannibal (AGPL boundary intact). This is operator-side config of the self-hosted instance, not a Hannibal source change.

**Verified after patch:** `/api/health` no longer `REDIS_DOWN` (now per-feed status — `ok` for the seeded feeds; the `crit`/`EMPTY` ones are simply un-seeded feeds like earthquakes, expected). The market + conflict RPCs serve live data through the clean API with `X-WorldMonitor-Key` (see §4). Fred confirmed live crypto data.

### 5b. ais-relay crash scope (reported, not fixed — per instruction)

`worldmonitor-ais-relay` is crash-looping with `Error: AISSTREAM_API_KEY environment variable not set`. **Scope = unrelated layer.** It is the **AIS vessel-tracking WebSocket relay** (`Dockerfile.relay`), feeding live maritime/vessel data only. It does **not** feed ConflictService (regional): `get-humanitarian-summary` returns **live data right now (Iran: 2,206 conflict events)** *while the relay is down* — proof of independence. The one "relay" mention in `list-ucdp-events.ts` is a **comment** noting that on the *hosted* (Railway) product UCDP is seeded by a `ais-relay.cjs` loop; in this **self-host**, UCDP/ACLED/Iran are seeded by host `scripts/seed-*.mjs`, not by the local relay container. The market `WS_RELAY_URL` (Yahoo/Finnhub relay) is also distinct from this AIS relay and not required for the seeded RPCs above. **Net:** leaving ais-relay dark costs only live vessel tracking; crypto/finance + regional are unaffected. Light it up later only if Fred wants maritime data (free `AISSTREAM_API_KEY`).

---

## 6. GPU / VRAM note (brief §4 question)

- WorldMonitor **pulls no models** and runs **no local inference by default**. Its only LLM touchpoint is optional "intelligence assessments," gated behind `LLM_API_URL` (any OpenAI-compatible endpoint) / `GROQ_API_KEY` / `OPENROUTER_API_KEY` — **all left unset**.
- Therefore it **does not compete** with Hannibal's models for the GPU. GEX131's RTX PRO 6000 Blackwell (97,887 MiB) is unaffected; at survey time a `deepseek-r1:70b` was loaded with ~17 GB free and it auto-unloads — WorldMonitor adds **0** to that.
- If we ever want WorldMonitor's narrative assessments, point `LLM_API_URL` at the local Ollama (`http://100.99.70.113:11434/v1/chat/completions`) — opt-in, and only then would it share the GPU.

---

## 7. State left on GEX131

- `~/worldmonitor` cloned; stack **up** via `docker compose`. `worldmonitor`, `-redis`, `-redis-rest` running; `-ais-relay` crash-looping (needs `AISSTREAM_API_KEY`, intentionally dark — scope in §5b). The `worldmonitor` container's compose healthcheck shows "unhealthy" only because most feeds are un-seeded (`/api/health` is a 194-feed aggregate); the **seeded feeds + clean API serve live data**.
- `~/worldmonitor/.env` (3 required secrets) + `~/worldmonitor/docker-compose.override.yml` (`WM_SESSION_SECRET`, `WORLDMONITOR_VALID_KEYS`, **+ the read-only bind-mount of the patched `local-api-server.mjs`**) — both gitignored. Patch backup at `…/local-api-server.mjs.orig-stage0bak`.
- Machine key for Hannibal: header `X-WorldMonitor-Key`, value in `WORLDMONITOR_VALID_KEYS` (rotate before Stage 1).
- **Live through the clean API now:** `list-crypto-quotes`, `get-fear-greed-index`, `list-stablecoin-markets`, `get-humanitarian-summary?country_code=XX`, `/api/polymarket`. Empty (own upstream/key reasons, not the API): UCDP (upstream version 404), Iran (scrape blocked), ACLED (needs free token), market-quotes/earnings/insiders (need Finnhub).
- Reachable across Tailscale: **`http://100.99.70.113:3000`** (dashboard for "eyes"; API base `/api/market/v1` + `/api/conflict/v1`).

**Stage 0 CLOSED ✅** — WorldMonitor self-hosted on GEX131 over Tailscale; real endpoints discovered + documented; clean API path serving live data via `X-WorldMonitor-Key`; live crypto confirmed by Fred. **No Hannibal-side code written. No further stages built. Awaiting Fred's stage-gate before Stage 1.**
