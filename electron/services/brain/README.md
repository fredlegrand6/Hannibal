# Brain ⇄ Body — Stage 1 (Hannibal across machines)

The foundation for "one brain, many bodies." The **brain** (planner + executor
decision-logic + memory) becomes an always-on service; each **body** (a Mac:
mic, screen, camera, speakers, command center, the confirmation **gate**, local
actions) connects to it over an authenticated WebSocket on Tailscale.

## Files
- `protocol.js` — the wire format (one JSON object per WS frame). RPC **down**
  (`body.invoke` / `body.confirm` / `emit`), result/progress/event **up**, big
  payloads by reference, generous timeouts. Single source of truth for both ends.
- `server.js` — the brain. WS server, token auth, handshake, healthcheck, and
  one read path today: `memory.query` (embed via Ollama + Qdrant search). Runs
  standalone: `node electron/services/brain/server.js`.
- `client.js` — the body side. Handshake, per-request timeouts, reconnect,
  **never hangs** (fast-fail so the body can fall back to in-process mode), and a
  handler hook for the brain's down-RPCs. Proof: `node electron/services/brain/client.js`.

## Status — Stage 1, steps 1–2 DONE (proven on loopback)
Mac body ↔ brain on `127.0.0.1` verified end-to-end:
- ✓ handshake + brain identity
- ✓ `health`
- ✓ `memory.query` returns real `hannibal_memory` hits (Qdrant on GEX131)
- ✓ bad token rejected fast (close 4003), down-brain fails fast (no hang)

Nothing in the running app changed — these are new, additive files behind env
config. `agent.run` is stubbed; relocating planner+executor onto the brain (with
the gate RPC'd **down** to the Mac) is **step 3**.

## Config (`.env`)
```
BRAIN_HOST=127.0.0.1   # bind iface for the brain
BRAIN_PORT=8788
BRAIN_TOKEN=<secret>   # second factor on top of Tailscale's authed transport
# Body override when the brain is remote:
# BRAIN_URL=ws://gex131-1:8788
# HANNIBAL_BRAIN=1 will route agent:run through the brain (step 3); default OFF.
```

## Relocating the brain to GEX131 (BLOCKED on SSH access)
The brain is machine-agnostic by design — moving it is deployment, not a rewrite.
Blocked today because this Mac has **no SSH to `gex131-1`** (`Permission denied
(publickey,password)`). Once access is granted:

1. Copy `electron/services/brain/` + a minimal `package.json` (dep: `ws`) to the box.
2. On the box set `BRAIN_HOST=0.0.0.0` (or its Tailscale IP `100.99.70.113`),
   keep the same `BRAIN_TOKEN`; `OLLAMA_URL`/`QDRANT_URL` become `127.0.0.1`
   (now local to the brain).
3. Run under a supervisor (systemd / pm2) so it's always-on.
4. On the Mac, set `BRAIN_URL=ws://gex131-1:8788` and re-run `client.js` — the
   exact same proof should pass over Tailscale instead of loopback.
