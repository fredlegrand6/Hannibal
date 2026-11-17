# WorldMonitor Desktop App — Data-Reachability Diagnosis

**Date:** 2026-06-09 · **Scope:** diagnosis only — NOTHING wired into Hannibal.
**Question:** can Hannibal READ live numbers from the installed desktop app, or is it eyes-only?

## Verdict (one line)
**Hannibal CAN read live data from the desktop app — it is NOT eyes-only.** The app runs a local HTTP API that returns live numbers (proven). But that API is **loopback-only + guarded by an ephemeral per-session token**, so it is a *Mac-body-local, app-must-be-running* source — not a stable brain-reachable feed. **Recommendation: app = eyes (visual), GEX131 self-host = ears (data feed). Keep two sources.**

---

## What the desktop app is
A **Tauri app** that ships the *same* `local-api-server.mjs` sidecar analysed in Stage 0:
- `/Applications/World Monitor.app/Contents/MacOS/world-monitor` (PID 53272) + Node sidecar (PID 53300).
- A second, **AppTranslocation** copy is also running (launched from quarantine before the move to /Applications) — Fred should quit one to avoid two live sidecars.
- `bundle id: app.worldmonitor.desktop`.

## 1. Does it expose data locally? — YES (with caveats)
- The sidecar binds a **local HTTP API, loopback only**:
  - `/Applications` instance → `127.0.0.1:54218`
  - translocated instance → `127.0.0.1:46123` (the Stage-0 default)
  - `lsof` confirms **127.0.0.1 only — no `0.0.0.0`, no Tailscale**. The brain on GEX131 cannot reach it; only a process on this Mac can.
- The live bound port is written to a file: **`~/Library/Logs/app.worldmonitor.desktop/sidecar.port`** (currently `54218`).
- Same `/api/...` surface as Stage 0 (`/api/local-status` reports `routes: 19`, incl. MarketService).
- **Auth gate:** every route requires `Authorization: Bearer <LOCAL_API_TOKEN>`. Unauthenticated → `401 {"error":"Unauthorized"}` (verified). The token is a **64-char per-session secret** the Tauri host generates at launch and passes to the sidecar via env. It is **env-only — NOT persisted** to any prefs/config file (confirmed), i.e. it **changes every launch**. It is readable on the Mac via the sidecar's process environment (`ps eww <sidecar-pid>`).

**Proven read** (token from sidecar env + port from the port file):
```
GET http://127.0.0.1:54218/api/market/v1/list-crypto-quotes   (Bearer <session token>)
→ {"quotes":[{"name":"Bitcoin","symbol":"BTC","price":63371,"change":1.1954,
              "sparkline":[60761.6, 61471.6, ... ]}, ...]}
```
Note the data is **richer than the self-host** — populated `sparkline[]`, fresh prices — because the desktop sidecar fetches upstreams live and caches in-memory (`mode: tauri-sidecar`, `cloudFallback:false`). "Fully hosted, all feeds live" = true.

## 2. Does it authenticate against a hosted API with a reusable key? — NOT usefully
- `local-status` reports `remoteBase: https://worldmonitor.app` with `cloudFallback:false` — the sidecar serves locally and only *falls back* to the cloud, which is currently off. So there is no active hosted-API call carrying a key we could lift.
- No reusable API/Pro key is stored on disk: the app-data dir holds only `persistent-cache.json` (the data cache). No `wm_` pro key, no API key in prefs. Any cloud auth would be a **Clerk web session inside WebKit LocalStorage** (`~/Library/WebKit/app.worldmonitor.desktop/.../LocalStorage/localstorage.sqlite3`) — a browser session, **not a clean machine key**, and brittle to reuse.
- **Conclusion:** there is no stable hosted-API key to reuse. The realistic local route is the loopback sidecar API, not the cloud.

## 3. Can Hannibal READ from the app? — YES, but it's a fragile local source
| Property | Desktop app local API | GEX131 self-host (Stage 0) |
|---|---|---|
| Returns live data | ✅ (richer: sparklines) | ✅ (clean API after the SSRF patch) |
| Reachable by the **brain** (GEX131) | ❌ loopback-only | ✅ Tailscale `100.99.70.113:3000` |
| Reachable by the **body** (Mac Electron) | ✅ same host | ✅ over Tailscale |
| Auth | ⚠️ ephemeral per-session bearer (regenerates each launch; scraped from `ps`/port file) | ✅ stable `X-WorldMonitor-Key` |
| Availability | ⚠️ only while the app is open | ✅ always-on (docker/systemd) |
| Stability across versions | ⚠️ private port-file path + env var, undocumented | ✅ documented HTTP contract |

---

## Recommendation (for the source decision — not yet wired)
**Two sources, by role:**
- **Eyes = the desktop app.** It's the better visual (native, rich, on the 71"). Stage 1's dual-dispatch "EYES" should *open the app* (`app.open "World Monitor"`) instead of the browser dashboard.
- **Ears = the GEX131 self-host.** Stable key, Tailscale, brain-reachable, app-independent, always-on. Keep it as the data feed the `world-read` normalizer consumes.

**Why not one-source-from-the-app:** doable only if you accept *body-only* (brain can't reach loopback), *app-must-be-open*, and *runtime token scraping* (read `sidecar.port` + `ps eww` for `LOCAL_API_TOKEN` each call). That's three fragilities the self-host doesn't have. The app's local API is best treated as an **optional richer ears-source the body taps when the app is running** — the `world-read` source seam already makes adding a `desktop-local` adapter a drop-in if Fred later wants the sparkline-grade data.

**Housekeeping:** two sidecars are live (translocated + /Applications). Quit the translocated copy so only the installed app runs.
