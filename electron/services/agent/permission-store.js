// ─────────────────────────────────────────────────────────────────────────
// PERMISSION STORE — ask-once-generalize for the confirmation gate. (Phase 3.)
//
// When you approve (or deny) a gated write and say "always" / "never", Hannibal
// remembers THAT SPECIFIC PATTERN and applies it next time — so it stops
// re-asking safe questions. This store is the memory behind that. It guards by
// remembering YOUR explicit choices; no model ever decides what is safe.
//
// HONESTY BACKSTOP: every remembered permission is one line in a human-readable
// JSON file (data/permissions.json, pretty-printed). "Hannibal learned X" must
// always be something you can open a file and read. `list()` returns exactly
// those rows; that auditable list is load-bearing, not a nice-to-have. This
// store is deliberately SEPARATE from the behavior-log / other learning layers —
// keep them legible and apart.
//
// TIERS (autonomy a remembered APPROVAL carries):
//   auto        — fires immediately on match, announced + logged.
//   cancel-beat — announces + opens a short interruptible window, then fires
//                 unless you stop it. The safe middle tier.
//   (deny)      — a remembered DENY auto-skips a match (announced). Always safe.
//
// CEILINGS (the most autonomy a tool may EVER reach) are declared per-tool in
// the catalog (`tool.permission.ceiling`). Two hard rules override the catalog:
//   • a tool with confirm!==true is never in scope (only gated writes),
//   • a tool flagged planner_safe:false is FORCED to ceiling 'never'.
// Anything without a declared ceiling defaults to 'never' (conservative — it
// keeps asking until a ceiling is deliberately raised in the catalog).
//
// FIRST-ALWAYS RULE: a first "always" lands at 'cancel-beat'. Reaching true
// 'auto' requires a second, deliberate opt-in (remember(..., {promote:true}))
// AND a tool whose ceiling is 'auto'.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const TIER_RANK = { 'cancel-beat': 1, auto: 2 };
const CEILING_RANK = { never: 0, 'cancel-beat': 1, auto: 2 };
const DEFAULT_FILE = path.join(__dirname, '..', '..', '..', 'data', 'permissions.json');

// The most autonomy this tool may ever be granted.
function ceilingFor(tool) {
  if (!tool || tool.confirm !== true) return 'never';   // only gated writes are in scope
  if (tool.planner_safe === false) return 'never';      // forced denylist (whatsapp.send, mac.shell, skills.execute)
  const c = tool.permission && tool.permission.ceiling;
  return CEILING_RANK[c] !== undefined ? c : 'never';   // undeclared → conservative
}

// The salient (param, value, match-mode) that identifies a pattern, per the
// tool's catalog declaration. null if the tool declares no key (→ not learnable).
function keyParts(tool, params) {
  const p = (tool && tool.permission) || {};
  if (!p.key) return null;
  const raw = params ? params[p.key] : undefined;
  if (raw == null || String(raw) === '') return null;
  return { tool: tool.name, param: p.key, value: String(raw), match: p.match === 'prefix' ? 'prefix' : 'exact' };
}

// For prefix-mode keys (paths), the stored pattern is the PARENT directory, so
// "always" on ~/Downloads/x.pdf generalizes to everything under ~/Downloads/.
function dirPrefix(value) {
  const trimmed = String(value).replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(0, idx + 1) : trimmed + '/';
}

function createPermissionStore(opts = {}) {
  const filePath = opts.filePath || DEFAULT_FILE;
  const now = opts.now || (() => new Date().toISOString());
  let entries = [];

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      entries = Array.isArray(j.entries) ? j.entries : [];
    } catch (_) { entries = []; }  // missing/corrupt → empty, never throw
    return entries;
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, entries }, null, 2));  // pretty = auditable
    } catch (e) { if (opts.strict) throw e; }
  }

  if (opts.entries) entries = opts.entries.slice();    // tests can seed in-memory
  else if (!opts.noLoad) load();

  // Does a stored entry cover this incoming pattern? exact = equal value;
  // prefix = incoming value begins with the stored prefix.
  function covers(entry, kp) {
    if (entry.tool !== kp.tool || entry.param !== kp.param) return false;
    if (entry.match === 'prefix') return kp.value.startsWith(entry.value);
    return entry.value === kp.value;
  }

  // Read-only: what does the store say for this gated call? Returns null (ASK),
  // or { decision:'approve'|'deny', tier, entry }. Prefers exact over prefix and
  // the longest prefix among ties.
  function lookup(tool, params) {
    const kp = keyParts(tool, params);
    if (!kp) return null;
    const hits = entries.filter((e) => covers(e, kp));
    if (!hits.length) return null;
    hits.sort((a, b) =>
      (a.match === 'exact' ? 1 : 0) - (b.match === 'exact' ? 1 : 0)
      || a.value.length - b.value.length);
    const entry = hits[hits.length - 1];
    return { decision: entry.decision, tier: entry.tier || null, entry };
  }

  function markUsed(entry) {
    const e = entries.find((x) => x.key === entry.key);
    if (e) { e.useCount = (e.useCount || 0) + 1; e.lastUsedAt = now(); save(); }
  }

  // Persist an explicit decision. Enforces ceiling + the first-always rule.
  // { decision:'approve'|'deny', tier?, promote? } → { ok, entry?, reason? }
  function remember(tool, params, { decision, tier, promote } = {}) {
    const kp = keyParts(tool, params);
    if (!kp) return { ok: false, reason: 'this action has no permission key to remember' };

    if (decision === 'deny') {                          // deny is always safe (auto-skip)
      const key = `${kp.tool}:${kp.param}:${kp.value}`;
      return upsert(key, { ...kp, value: kp.value, match: 'exact', decision: 'deny', tier: null });
    }

    // approve
    const ceiling = ceilingFor(tool);
    if (ceiling === 'never') return { ok: false, reason: `${tool.name} can never be auto-approved — it will always ask` };

    const storedValue = kp.match === 'prefix' ? dirPrefix(kp.value) : kp.value;
    const key = `${kp.tool}:${kp.param}:${storedValue}`;
    const existing = entries.find((x) => x.key === key);

    // A fresh "always" NEVER lands on auto — it's cancel-beat (capped at ceiling).
    // True auto is reachable only by PROMOTING an existing cancel-beat entry via a
    // deliberate second opt-in, and only when the ceiling permits it.
    let want = (tier && tier !== 'auto') ? tier : 'cancel-beat';
    if (TIER_RANK[want] > CEILING_RANK[ceiling]) want = ceiling;
    if (existing && existing.decision === 'approve' && existing.tier === 'cancel-beat'
        && promote && ceiling === 'auto') {
      want = 'auto';
    }
    return upsert(key, { ...kp, value: storedValue, decision: 'approve', tier: want });
  }

  function upsert(key, fields) {
    let e = entries.find((x) => x.key === key);
    if (e) {
      Object.assign(e, { decision: fields.decision, tier: fields.tier });
    } else {
      e = {
        key, tool: fields.tool, param: fields.param, value: fields.value, match: fields.match,
        decision: fields.decision, tier: fields.tier, grantedAt: now(), lastUsedAt: null, useCount: 0,
      };
      entries.push(e);
    }
    save();
    return { ok: true, entry: e };
  }

  function promote(tool, params) { return remember(tool, params, { decision: 'approve', tier: 'auto', promote: true }); }
  function revoke(key) { const n = entries.length; entries = entries.filter((e) => e.key !== key); if (entries.length !== n) { save(); return true; } return false; }
  function list() { return entries.map((e) => ({ ...e })); }      // the auditable "what am I auto-approving" list
  function clear() { entries = []; save(); }

  return { lookup, remember, promote, revoke, markUsed, list, clear, load, save, filePath };
}

let _default = null;
function getDefaultPermissionStore() { if (!_default) _default = createPermissionStore(); return _default; }

module.exports = { createPermissionStore, getDefaultPermissionStore, ceilingFor, keyParts, dirPrefix, TIER_RANK, CEILING_RANK };
