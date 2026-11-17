// ─────────────────────────────────────────────────────────────────────────
// WORLD AWARENESS · DUAL DISPATCH (brief §3.4) — one command, two actions in
// the same beat:
//   • EYES: open the WorldMonitor view for the topic (desktop app by default —
//     the diagnosis verdict; or the browser dashboard if WORLD_EYES_MODE=browser).
//   • EARS: route the spoken topic → fetch → normalize → narrate one line.
//
// Wired as read-only tools the planner/executor can call:
//   world.read  (topic param)  — any topic via the Stage-2 router
//   world.crypto               — back-compat shortcut (Stage 1)
// Read-only — no write path; the permission gate passes it through; LoopGuard
// applies normally inside a planner sequence.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { route } = require('./router');
const { narrate } = require('./world-narrator');

// EYES — resolve a view descriptor into an open action, reusing the existing
// app-launcher / browser-action handlers. Never throws.
function openView(ipcMain, v) {
  if (!v) return false;
  const reg = ipcMain && ipcMain.__toolTapRegistry;
  try {
    if (v.kind === 'app' && reg && reg['mac-control']) { reg['mac-control']({}, 'open-app', v.app); return true; }
    if (v.kind === 'url' && reg && reg['browser-action']) { reg['browser-action']({}, 'open', v.url); return true; }
  } catch (_) { /* fall through to shell */ }
  // fallbacks
  try {
    if (v.kind === 'app') {
      const url = v.fallbackUrl;
      if (reg && reg['browser-action'] && url) { reg['browser-action']({}, 'open', url); return true; }
    }
    const url = v.url || v.fallbackUrl;
    if (url) { require('electron').shell.openExternal(url); return true; }
  } catch (_) { /* ignore */ }
  return false;
}

// Run a topic dual-dispatch. `spoken` is a spoken phrase OR a topic key.
// Returns a stable shape; never throws.
async function runTopic(ipcMain, spoken, { open = true } = {}) {
  let topic;
  try { topic = await route(spoken); }
  catch (_) { topic = null; }

  if (!topic) {
    return { ok: true, declined: true, topic: null, narration: "I don't track that one yet — try crypto, markets, news, a region, energy, conflict, flights, or the weather." };
  }

  // EYES first (same beat) — independent of the data read.
  let viewOpened = false;
  if (open) { try { viewOpened = openView(ipcMain, topic.view()); } catch (_) {} }

  let worldRead;
  try { worldRead = await topic.build(); }
  catch (e) { return { ok: false, topic: topic.key, viewOpened, error: e.message, narration: `I couldn't pull ${topic.label} right now.` }; }

  const { line, source } = await narrate(worldRead);
  return {
    ok: true, topic: topic.key, label: topic.label,
    narration: line, narratorSource: source,
    worldRead, viewOpened,
    asOf: worldRead.asOf, degraded: (worldRead.missing && worldRead.missing.length > 0),
  };
}

function registerWorld(ipcMain) {
  // Generic topic read (Stage 2/3).
  ipcMain.handle('world:read', async (_e, arg) => {
    const a = arg || {};
    return runTopic(ipcMain, a.topic || 'news', { open: a.open !== false });
  });
  // Back-compat: the Stage-1 crypto shortcut.
  ipcMain.handle('world:crypto', async (_e, arg) => {
    const a = arg || {};
    return runTopic(ipcMain, 'crypto', { open: a.open !== false });
  });
}

module.exports = { registerWorld, runTopic, openView };
