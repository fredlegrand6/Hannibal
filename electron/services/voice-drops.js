// VOICE DROPOUTS — a small log of every time Hannibal's voice failed.
//
// One JSON line per dropout: when, where (desk / phone / server), the stage it
// failed at (tts = the voice request, decode, play, queue), the error, the
// speakers in use, and whether he recovered on his own (retry worked) or the
// sentence was skipped. Hannibal reads it back with the voice.dropouts tool:
// "did your voice drop out today?".
//   Mac:    ~/Library/Logs/Hannibal/voice-dropouts.log
//   server: data/voice-dropouts.log (phone app + voice notes)
// HANNIBAL_VOICE_DROP_LOG overrides the path. Kept to the last ~1000 lines.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const STAGES = new Set(['tts', 'decode', 'play', 'queue']);
const MAX_LINES = 1000;

function defaultFile() {
  return process.env.HANNIBAL_VOICE_DROP_LOG || path.join(os.homedir(), 'Library', 'Logs', 'Hannibal', 'voice-dropouts.log');
}

function clean(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }

function createVoiceDropLog({ file = defaultFile(), now = () => new Date(), log = (m) => console.warn(m) } = {}) {
  let writes = 0;

  function record(d = {}) {
    const entry = {
      t: now().toISOString(),
      where: clean(d.where || 'desk', 20),
      stage: STAGES.has(d.stage) ? d.stage : 'play',
      error: clean(d.error || 'unknown', 300),
      device: clean(d.device || 'unknown', 120),
      recovered: !!d.recovered,
    };
    if (d.path) entry.path = clean(d.path, 20);
    if (d.text) entry.text = clean(d.text, 80);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
      if (++writes % 50 === 0) trim();
    } catch (e) { log(`[voice-drop] could not write ${file}: ${e.message}`); }
    log(`[voice-drop] ${entry.where} ${entry.stage}: ${entry.error} — ${entry.device}${entry.recovered ? ' (recovered by itself)' : ' (sentence skipped)'}`);
    return entry;
  }

  function trim() {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > MAX_LINES) fs.writeFileSync(file, lines.slice(-MAX_LINES).join('\n') + '\n');
    } catch (_) {}
  }

  function all() {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    } catch (_) { return []; }
  }

  // hours: look back this far (default: since midnight today, local time).
  function list(hours) {
    const end = now();
    let since;
    const h = Number(hours);
    if (h > 0) since = new Date(end.getTime() - h * 3600000);
    else { since = new Date(end); since.setHours(0, 0, 0, 0); }
    const items = all().filter((e) => new Date(e.t) >= since);
    return summarize(items, { since, hours: h > 0 ? h : null });
  }

  return { record, list, all, file };
}

function summarize(items, { since, hours } = {}) {
  const span = hours ? `in the last ${hours} hour${hours === 1 ? '' : 's'}` : 'today';
  const byStage = {};
  for (const e of items) byStage[e.stage] = (byStage[e.stage] || 0) + 1;
  const skipped = items.filter((e) => !e.recovered).length;
  const summary = items.length
    ? `${items.length} voice dropout${items.length === 1 ? '' : 's'} ${span} (${Object.entries(byStage).map(([k, v]) => `${v} at ${k}`).join(', ')}); `
      + `${items.length - skipped} fixed themselves, ${skipped} sentence${skipped === 1 ? ' was' : 's were'} skipped.`
    : `No voice dropouts ${span}.`;
  return {
    ok: true, since: since ? since.toISOString() : null, count: items.length, skipped, by_stage: byStage, summary,
    dropouts: items.slice(-30),
  };
}

// Mac + server lists put together (the server asks the linked Mac for its part).
function merge(a, b, hours) {
  const items = [...((a && a.dropouts) || []), ...((b && b.dropouts) || [])].sort((x, y) => String(x.t).localeCompare(String(y.t)));
  const since = [a && a.since, b && b.since].filter(Boolean).sort()[0] || null;
  const h = Number(hours);
  return summarize(items, { since: since ? new Date(since) : null, hours: h > 0 ? h : null });
}

function registerVoiceDrops(ipcMain, store, { where = 'desk' } = {}) {
  ipcMain.handle('voice:drop', (_e, d) => { store.record({ where, ...(d || {}) }); return { ok: true }; });
  ipcMain.handle('voice:dropouts', (_e, hours) => store.list(hours));
}

module.exports = { createVoiceDropLog, registerVoiceDrops, summarize, merge, STAGES };
