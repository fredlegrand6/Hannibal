# WorldMonitor — Free-vs-Pro Feed Audit (self-host)

**Date:** 2026-06-09 · **Scope:** diagnosis only — nothing wired, nothing changed.
**Question Fred is deciding:** Pro ($99/mo) pitches "one key replaces 20+ API keys you'd provision yourself." Is that true — are the dark tiles **unkeyed free feeds**, or genuinely **paywalled**?

## Bottom line (read this first)
**Pro's pitch is essentially TRUE.** The dark tiles are overwhelmingly **free feeds you'd provision/run yourself**, not locked data. Almost nothing Fred listed is a paid datasource. What Pro actually sells is **the labour**: provisioning ~8–12 free keys, deploying the Railway relay, and running the seeder cron — plus genuine Pro extras (hosted MCP, AI briefings, sub-minute refresh).

**Why everything looks dark on the self-host:** feeds are populated by **host seeders** (`scripts/seed-*.mjs` → Redis) and/or the **Railway relay** (RSS/vessels/aircraft/Telegram). In Stage 0 we ran only ~4 key-free seeders. So a dark tile means *"seeder/relay not run yet"* far more often than *"needs a paid key."*

---

## The tiles Fred listed

| Tile | Bucket | Provider / upstream | Free-tier limit | Fix effort |
|---|---|---|---|---|
| **World News** (live) | **A — free, NO key** | YouTube live channels (BBC, Sky, DW, France24, Al Jazeera…) via local embed bridge | unlimited | trivial — embed bridge only |
| **US / North America** | **A — free, NO key** | YouTube live (CNN, PBS, etc.) | unlimited | trivial |
| **Europe** | **A — free, NO key** | YouTube live (euronews, DW, France24, BBC…) | unlimited | trivial |
| **Middle East** | **A — free, NO key** | YouTube live (Al Jazeera, TRT, i24…) | unlimited | trivial |
| **Africa** | **A — free, NO key** | YouTube live (Africanews, eNCA, SABC…) | unlimited | trivial |
| **Latin America** | **A — free, NO key** | YouTube live (regional channels) | unlimited | trivial |
| **Asia-Pacific** | **A — free, NO key** | YouTube live (NHK, CNA…) | unlimited | trivial |
| **News intelligence** (the *text* news behind regions) | **A — free, NO key** | GDELT (`api.gdeltproject.org`) via `seed-gdelt-intel` | free, IP-rate-limited | run the seeder (cron) |
| **Energy** | **A — mostly free** | `energy-intelligence` scrapes IEA/OPEC/oilprice (no key); `eia-petroleum`/`fuel-prices` = **EIA key (free)**; `jodi-oil/gas` (free), `ember-electricity` (free), `gie-gas-storage` = **GIE/AGSI key (free)** | EIA generous; GIE free | 2 free keys + run seeders; **scrapers are fragile** |
| **Government** (regulatory/gov actions) | **A — free, NO key** | `regulatory-actions`: FINRA (`feeds.finra.org`), CFTC, GovDelivery RSS (+ USAspending.gov) | free public feeds | run the seeder |
| **Cross-source aggregator** | **A — free (derived)** | `cross-source-signals` / `correlation` — computed from the *other* feeds; optional LLM = **GROQ (free 14.4k/day)** or our **Ollama** | n/a | needs the underlying feeds populated first |
| **Conflict counters `U:0 C:0 S:0 I:0`** | **A — free, partly D** | Composite "Conflict Intensity Index" (CII). Decoded: **U**nrest, **C**onflict, **S**ecurity, **I**nformation. Sub-feeds: U=GDELT(free)+ACLED; C=UCDP+ACLED; S=military flights/vessels; I=GDELT | see below | mixed — see note |

### What the U/C/S/I counter actually needs (it's a composite)
- **U — Unrest:** GDELT (free, no key) + ACLED. → free
- **C — Conflict:** **ACLED** token (free for researchers, email+pass auto-refresh) + **UCDP** token (free signup) — **but UCDP GED upstream is currently 404 (bucket D, same as Stage 0)**.
- **S — Security:** military flights = **OpenSky** (free OAuth) + vessels = **AISStream** (free key) — **both require the Railway relay deployed** (the biggest "free-but-effortful" gap).
- **I — Information:** GDELT news velocity (free, no key).
→ So the counter reads `0 0 0 0` because none of those seeders/relay are running — **not because it's paywalled.** All inputs are free or free-key; one (UCDP) is a broken upstream; the Security row needs relay infra.

---

## Bucket summary (the tiles above + their direct inputs)

- **A — FREE (no key or free-signup key):** **the vast majority.** News + all 7 regional tiles (no key), GDELT news intel (no key), Government/regulatory (no key), cross-source aggregator (no key, derived), JODI/Ember/IEA energy (no key), weather (Open-Meteo, no key); free-signup keys for EIA, GIE, ACLED, UCDP, Finnhub, AviationStack, NASA FIRMS, AISStream, OpenSky, OpenAQ.
- **B — PAID upstream:** **very few.** Cloudflare Radar (internet outages) needs paid Radar access; CorridorRisk (maritime corridor scoring) optional paid. These are *not* in Fred's wishlist.
- **C — PRO-ONLY (WorldMonitor's $99 convenience/extras):** the hosted **MCP server**, **AI digests/briefings** at scale, **sub-minute refresh**, the **hosted relay** (e.g. `military-maritime-news` → `api.worldmonitor.app`), and the headline **"one key for 20+"** managed provisioning. *(Note: AI briefings/correlation can run free on GROQ or our Ollama when self-hosted — so they're a Pro convenience, not a hard lock.)*
- **D — UPSTREAM-BROKEN (free but failing now):** **UCDP GED** (404, the "C" in the conflict counter), **Reddit** (403 → social-velocity / WSB tickers; new API apps blocked since 2026), **iran-events** (LiveUAMap scrape blocked).

**Count for Fred's listed tiles:** **11 free-key/no-key · 0 paid-upstream · 0 hard Pro-only · 1 partly-broken** (the conflict counter's UCDP "C" input).

---

## Effort to light them FREE (bucket A reality check)
It's "free" in *dollars*, but it's real *ops work*:
1. **~8–12 free keys** to register. Instant/easy: EIA, Finnhub, NASA FIRMS, GIE. Medium: ACLED (researcher signup + email/pass OAuth), AviationStack (free tier is **rate-limited — ~100–500 req/mo**), OpenSky. No key at all: GDELT, YouTube news, FINRA/CFTC, Open-Meteo, JODI, Ember.
2. **Deploy the Railway relay** (`ais-relay.cjs`) for anything live-streamed: vessels (AISStream), aircraft (OpenSky), Telegram OSINT, and the RSS proxy. This is infra, not a key — the single biggest gap.
3. **Run the seeders on a cron** (every ~30 min) to keep Redis fresh. Stage 0 ran them once by hand.
4. **Babysit fragile bits:** scrapers (OPEC/IEA/oilprice, LiveUAMap) and upstreams that change policy (UCDP, Reddit, ReliefWeb already shifted).

That ladder of work **is the thing Pro is selling.**

---

## Bottom line for the feeds Fred cares about (news, regional, markets, weather, flights)

| Category | Reachable FREE? | Key needed |
|---|---|---|
| **News** (live + GDELT intel) | ✅ FREE | none |
| **Regional** (US/EU/ME/Africa/LatAm/APAC) | ✅ FREE | none |
| **Markets** (crypto live already; stocks/indices) | ✅ FREE | crypto = none (live since Stage 0); stocks = **Finnhub free key** |
| **Weather** (Naarden + Ibiza) | ✅ FREE | none (Open-Meteo, no auth) |
| **Flights** | ✅ FREE | **AviationStack free key** (+ FAA delays free, no key) |

**→ All 5 of Fred's categories are reachable FREE. None require Pro.** Three need **zero keys** (news, regional, weather); two need **one free-signup key each** (Finnhub for stocks, AviationStack for flights — the latter's free tier is rate-limited).

**So: don't pay $99/mo for *data access* — the data isn't locked.** Pay for Pro only if Fred wants the *convenience* (skip provisioning + relay + cron) or the genuine extras (MCP, AI briefings, fast refresh). And note: **Hannibal doesn't need the dashboard tiles populated at all** — it reads specific endpoints (crypto already live), and the **desktop app already shows every feed live for the *eyes*.** For Hannibal's *ears*, Fred only provisions the handful of free feeds Hannibal actually reads — a far smaller job than lighting the whole board.
