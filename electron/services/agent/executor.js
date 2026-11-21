// ─────────────────────────────────────────────────────────────────────────
// EXECUTOR — walks a Planner plan and runs it. (Stage 3: READ steps only.)
//
// Runs in the Electron MAIN process, because it must reach the real service
// handles already wired there: the SSH metrics call, Zoho mail, the file
// system, screen capture, web fetch, the persisted lists, etc. Those all live
// as `ipcMain.handle(...)` handlers in main.js / system-control.js.
//
// HOW IT CALLS THEM WITHOUT CHANGING THEM — the "tool tap":
//   installToolTap(ipcMain) wraps ipcMain.handle so that every (channel ->
//   listener) registration is also recorded in a registry. The handlers still
//   register and behave EXACTLY as before; we just keep a reference so the
//   executor can invoke the same function the renderer would trigger over IPC.
//   The listeners take (event, ...args) and ignore the event, so we call them
//   with a stub `{}` event. Zero behavior change.
//
// DEPENDENCY PASSING (honest, declared-only):
//   Before a step runs, any param value of the form "{{stepN}}" (or "{{N}}") is
//   replaced with step N's recorded OUTPUT — but ONLY if N is in this step's
//   depends_on. An undeclared reference is treated as an error, never silently
//   resolved. This is the Stage-2 contract enforced at run time.
//
// CONFIRMATION GATE (Stage 4):
//   • read steps run automatically.
//   • write steps with confirm:true (catalog.confirmRequired) are gated: the
//     executor summarizes the action in one plain sentence, calls opts.confirmer
//     for an explicit yes/no, and only executes on yes. On no it SKIPS that step
//     and continues with the rest of the plan. Each gated write is asked
//     separately — confirmations are NEVER batched.
//   • write steps with confirm:false (internal housekeeping) execute directly.
//   • opts.dryRun:true keeps the old Stage-3 behavior — describe every write as
//     "would perform: <desc>" and never execute it (used for plan previews).
//   With no confirmer wired, the gate DENIES by default, so nothing is ever sent
//   unattended.
//
// PROGRESS:
//   Every transition emits an event via opts.emit (default: console). Stage 6
//   binds these to spoken progress + the neural brain.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');
const { createLoopGuard } = require('./loop-guard');
const { summarizeObservation } = require('./context-compress');
const { getDefaultPermissionStore, ceilingFor } = require('./permission-store');

// minimal .env loader so standalone runs (and the renderer shims) get creds.
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '..', '..', '.env');
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch (_) { /* fine */ }
})();

const CFG = {
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  fastModel: process.env.OLLAMA_MODEL_FAST || 'llama3.2:3b',
  qdrantUrl: process.env.QDRANT_URL || 'http://gex131-1:6333',
  qdrantCollection: process.env.QDRANT_COLLECTION || 'hannibal_memory',
  embedModel: process.env.EMBED_MODEL || 'nomic-embed-text',
};

// ── the tool tap ───────────────────────────────────────────────────────────
// Call once, BEFORE any ipcMain.handle(...) runs (i.e. before registerControls
// and before main.js's own handler registrations). Returns the registry and
// also stashes it for the default invoker.
function installToolTap(ipcMain) {
  if (ipcMain.__toolTapRegistry) return ipcMain.__toolTapRegistry; // idempotent
  const registry = {};
  const orig = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    registry[channel] = listener;
    return orig(channel, listener);
  };
  ipcMain.__toolTapRegistry = registry;
  installToolTap._registry = registry;
  return registry;
}

// ── renderer-side read tools, re-implemented main-side so the executor can run
//    them too (they normally live in src/voice-controller.js). Read-only. ──
async function shimMemoryQuery({ text, limit = 3 } = {}) {
  const er = await fetch(`${CFG.ollamaUrl}/api/embeddings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // keep_alive pins nomic-embed-text warm (matches planner.js) so it isn't
    // cold-loaded on every call; 20s budget survives a cold load when the shared
    // GEX131 GPU is busy — the 10s budget here was tripping under contention.
    body: JSON.stringify({ model: CFG.embedModel, prompt: text, keep_alive: '30m' }),
    signal: AbortSignal.timeout(20000),
  });
  const vec = (await er.json()).embedding;
  if (!vec) return { ok: false, error: 'embed failed', results: [] };
  const r = await fetch(`${CFG.qdrantUrl}/collections/${CFG.qdrantCollection}/points/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {}) },
    body: JSON.stringify({ vector: vec, limit, with_payload: true, score_threshold: 0.35 }),
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json();
  return { ok: true, results: (j.result || []).map((p) => ({ text: p.payload?.text || p.payload?.content || '', score: p.score })).filter((m) => m.text) };
}
async function shimTranslate({ text, language } = {}) {
  const r = await fetch(`${CFG.ollamaUrl}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CFG.fastModel, stream: false, options: { temperature: 0 },
      messages: [
        { role: 'system', content: `You are a translation engine. Translate the user's input into ${language}. Reply with ONLY the translation — no preamble, no quotes.` },
        { role: 'user', content: String(text || '') },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  return { ok: true, text: (await r.json()).message?.content?.trim() || '' };
}
const RENDERER_SHIMS = { 'memory.query': shimMemoryQuery, 'translate.text': shimTranslate };
// Let the app swap in a better runner (main uses qdrant-memory.js for memory.query).
function setShim(name, fn) { if (typeof fn === 'function') RENDERER_SHIMS[name] = fn; }

// ── invoker: catalog tool name -> the real handler call ──────────────────────
function marshalControl(tool, params) {
  // mac-control / browser-action handlers take a single `params` arg: a bare
  // value for single-param actions, an object for multi-param ones (they do
  // `typeof params === 'string' ? JSON.parse : params`).
  const keys = tool.params.map((p) => p.name);
  if (keys.length === 0) return undefined;
  if (keys.length === 1) return params[keys[0]];
  const o = {};
  keys.forEach((k) => { if (params[k] !== undefined) o[k] = params[k]; });
  return o;
}

function makeIpcInvoker(registry) {
  return async function invoke(toolName, params) {
    const tool = catalog.getTool(toolName);
    if (!tool) throw new Error(`unknown tool ${toolName}`);
    const via = tool.via || {};
    if (via.module) {                       // renderer read tool → main-side shim
      const shim = RENDERER_SHIMS[toolName];
      if (!shim) throw new Error(`no main-side shim for renderer tool ${toolName}`);
      return shim(params || {});
    }
    const fn = registry[via.channel];
    if (!fn) throw new Error(`no handler for channel "${via.channel}" (tool ${toolName}) — is the app running / tap installed?`);
    if (via.action) {                       // mac-control / browser-action
      return fn({}, via.action, marshalControl(tool, params || {}));
    }
    // direct handler: positional args in declared param order
    return fn({}, ...tool.params.map((p) => (params || {})[p.name]));
  };
}

// ── declared-dependency param resolution ─────────────────────────────────────
// A reference is {{N}} / {{stepN}} for a whole output, or {{N.path}} for a part
// of it — e.g. {{2.body}}, {{1.messages[0].uid}}, {{3.text}}. The path is
// resolved against step N's recorded output using its catalog `returns` shape.
const REF_SRC = '\\{\\{\\s*(?:step)?\\s*(\\d+)((?:\\.[A-Za-z_$][\\w$]*|\\[\\d+\\])*)\\s*\\}\\}';
const SOLE_REF = new RegExp('^\\s*' + REF_SRC + '\\s*$', 'i');
const ANY_REF = new RegExp(REF_SRC, 'gi');

// Navigate "messages[0].uid" / "body" into an object. Returns undefined on miss.
function getPath(obj, path) {
  if (!path) return obj;
  const parts = path.replace(/^\./, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

// `inj` (optional) carries observation-summary substitution:
//   { summaries: { N: "<short summary>" }, useSummary: <bool>, used: Set<int> }
// It ONLY ever affects a WHOLE-VALUE {{N}} reference (no field path) whose target
// is a non-write step — exactly the overflow vector where a huge read output
// would be poured into a downstream model tool. Precise {{N.path}} refs and any
// reference feeding a WRITE always resolve to the full, exact value, so the
// Stage-2 dependency contract and "writes send exactly what's shown" are intact.
function resolveValue(value, results, declared, problems, inj = {}) {
  if (typeof value === 'string') {
    const sole = value.match(SOLE_REF);
    if (sole) {                              // whole value is one ref → inject the resolved value (any type)
      const n = +sole[1], path = sole[2] || '';
      if (!declared.includes(n)) { problems.push(`references step ${n} not in depends_on`); return value; }
      if (!(n in results)) { problems.push(`step ${n} has no output yet`); return value; }
      if (!path && inj.useSummary && inj.summaries && inj.summaries[n] != null) {
        if (inj.used) inj.used.add(n);       // whole-object injection into a non-write tool → use the summary
        return inj.summaries[n];
      }
      const v = getPath(results[n], path);
      if (v === undefined) { problems.push(`step ${n} output has no path "${path.replace(/^\./, '')}"`); return value; }
      return v;
    }
    return value.replace(ANY_REF, (m, d, p) => { // embedded refs → string interpolation
      const n = +d, path = p || '';
      if (!declared.includes(n)) { problems.push(`references step ${n} not in depends_on`); return m; }
      if (!(n in results)) { problems.push(`step ${n} has no output yet`); return m; }
      const v = getPath(results[n], path);
      if (v === undefined) { problems.push(`step ${n} output has no path "${path.replace(/^\./, '')}"`); return m; }
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, results, declared, problems, inj));
  if (value && typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value)) o[k] = resolveValue(value[k], results, declared, problems, inj);
    return o;
  }
  return value;
}

function resolveParams(step, results, inj) {
  const problems = [];
  const declared = Array.isArray(step.depends_on) ? step.depends_on : [];
  const params = resolveValue(step.params || {}, results, declared, problems, inj || {});
  return { params, problems };
}

// One plain sentence describing a write action, for the spoken/shown prompt.
// Uses the RESOLVED params so the user hears exactly what will happen.
function summarizeAction(step, params) {
  const p = params || {};
  const q = (s) => `“${s}”`;
  switch (step.tool) {
    case 'whatsapp.send': return `Send a WhatsApp to ${p.contact}: ${q(p.message)} — send it?`;
    case 'imessage.send': return `Send an iMessage to ${p.contact || p.number}: ${q(p.message)} — send it?`;
    // mail.send only OPENS a pre-filled compose window (mailto:) — it does not
    // auto-send — so the prompt says "open", not "send". The body preview lets
    // Fred see the actual drafted reply before approving.
    case 'mail.send': {
      const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const bodyPrev = p.body ? ` — “${flat(p.body).slice(0, 160)}${flat(p.body).length > 160 ? '…' : ''}”` : '';
      return `Open a pre-filled email to ${p.to}${p.subject ? ` about ${q(p.subject)}` : ''}${bodyPrev} — go ahead?`;
    }
    // Real sends from Zoho: Fred sees/hears the WHOLE draft and who gets it.
    case 'mail.reply': {
      const body = String(p.body || '').trim();
      return `Send this reply to ${p.to}: “${body.length > 1200 ? body.slice(0, 1200) + '…' : body}” — send it?`;
    }
    case 'mail.write': {
      const body = String(p.body || '').trim();
      return `Send an email to ${p.to} about “${p.subject || ''}”: “${body.length > 1200 ? body.slice(0, 1200) + '…' : body}” — send it?`;
    }
    case 'file.trash':    return `Move ${p.path} to the Trash — go ahead?`;
    case 'mac.emptyTrash':return `Empty the Trash permanently — go ahead?`;
    case 'mac.sleep':     return `Put the machine to sleep — go ahead?`;
    case 'app.quit':      return `Quit ${p.name} — go ahead?`;
    case 'browser.typeInBrowser': return `Type ${q(p.text)} into the browser — go ahead?`;
    case 'browser.clickLink':     return `Click ${q(p.text)} in the browser — go ahead?`;
    case 'browser.fillField':     return `Fill the ${q(p.field)} field with ${q(p.value)} — go ahead?`;
    default:              return `${step.description || step.tool} — go ahead?`;
  }
}

// short, log-friendly rendering of a tool result
function summarize(out) {
  try {
    if (out == null) return String(out);
    if (typeof out === 'string') return out.length > 160 ? out.slice(0, 160) + '…' : out;
    if (Buffer.isBuffer(out) || out instanceof Uint8Array) return `<${out.length} bytes>`;
    const s = JSON.stringify(out);
    return s.length > 220 ? s.slice(0, 220) + '…' : s;
  } catch (_) { return '[unserializable]'; }
}

// ── ERROR POLICY (Stage 5) ───────────────────────────────────────────────────
// Classify a failed step into one of four recovery decisions using the FAST
// Ollama model on GEX131. Falls back to a cautious "retry" if the classifier
// itself is unreachable (a classifier outage is itself transient).
const DECISIONS = ['retry', 'skip', 'replan', 'abort'];
async function defaultClassify(step, errorMsg) {
  const sys = 'You classify a failed plan step into exactly one recovery decision. '
    + 'Output strict JSON: {"decision": "...", "reason": "..."}. decision ∈ retry|skip|replan|abort.\n'
    + '- retry: a transient/environmental error likely to pass on a retry — network timeout, '
    + 'connection refused/ECONNREFUSED, socket hang up, temporary lock, rate limit, HTTP 5xx.\n'
    + '- skip: the step is optional; the overall goal can still succeed without it.\n'
    + '- replan: the chosen tool/approach was wrong for the goal; a different tool or sequence might work.\n'
    + '- abort: impossible or unsafe to continue at all.';
  const user = `STEP tool: ${step.tool}\nSTEP description: ${step.description || ''}\n`
    + `critical: ${!!step.critical}\nERROR: ${errorMsg}`;
  try {
    const res = await fetch(`${CFG.ollamaUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CFG.fastModel, stream: false, format: 'json', options: { temperature: 0 },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await res.json();
    const parsed = JSON.parse(j.message?.content || '{}');
    const d = String(parsed.decision || '').toLowerCase();
    if (DECISIONS.includes(d)) return { decision: d, reason: parsed.reason || '' };
  } catch (_) { /* fall through */ }
  return { decision: 'retry', reason: 'classifier unavailable — cautious retry' };
}

// Ask the Planner for a fresh plan of the REMAINING work. Lazy require avoids
// any load-order coupling (planner does not import executor).
async function defaultReplan(remainingGoal) {
  return require('./planner').plan(remainingGoal);
}

// ── the walk ─────────────────────────────────────────────────────────────────
async function execute(plan, opts = {}) {
  const emit = opts.emit || ((e) => console.log('[exec]', JSON.stringify(e)));
  const invoke = opts.invoke || makeIpcInvoker(installToolTap._registry || {});
  const dryRun = opts.dryRun === true;  // true = describe writes, never execute (plan preview)
  // The confirmation gate. Called once PER confirm-required write — never batched.
  // Safe default when none is wired: deny, so nothing is sent unattended.
  const confirmer = opts.confirmer || (async (step, summary) => {
    emit({ type: 'step:no-confirmer', step: step.step, tool: step.tool, summary });
    return false;
  });
  const classify = opts.classify || defaultClassify;
  const replan = opts.replan || defaultReplan;
  const maxRetries = opts.maxRetries == null ? 2 : opts.maxRetries;   // per step
  const maxReplans = opts.maxReplans == null ? 2 : opts.maxReplans;   // total
  const goal = (plan && plan.goal) || '';

  // LOOP GUARD — fresh per run, so its state resets on every execute() call.
  // Knobs come from opts.loopGuard (camelCase or the brief's snake_case both work).
  const guard = createLoopGuard(opts.loopGuard || {});

  // PERMISSION STORE — PERSISTS across runs (that's the point: remember "always"
  // between sessions). The auditable JSON is the honesty backstop.
  const permissions = opts.permissions || getDefaultPermissionStore();
  // cancel-beat needs a wired human channel ("say stop" / a Cancel button). When
  // none is wired we fall back to a full ask — nothing fires unattended.
  const cancelBeat = opts.cancelBeat || null;

  // CONTEXT COMPRESSION knobs (opts.compress):
  //   observations:true  → summarize large TEXTUAL tool outputs via the 3B model
  //   injections:true    → use those summaries when a whole {{N}} is poured into a
  //                        non-write tool (off by default; protects the honesty
  //                        contract — flip on once reviewed).
  const compress = opts.compress || {};
  const summaries = {};       // stepNumber -> short summary string (large outputs only)

  const steps = ((plan && plan.steps) || []).slice(); // mutable — replan splices it
  const results = {};       // stepNumber -> output (for dependency passing)
  const record = [];        // ordered execution log
  const retries = {};       // stepNumber -> retries used
  let replanCount = 0;

  emit({ type: 'plan:start', goal, steps: steps.length });
  let aborted = false, haltReason = null;

  // Ask the Planner for a fresh plan of the REMAINING work and splice it in at
  // `idx`. Shared by the failure path (onFailure) and the loop-guard self-
  // correction path. `loopBreak:true` swaps the failure note for a loop-break
  // instruction telling the planner which approach is spinning and to change it.
  // Returns 'replanned' (spliced — re-run from idx) or 'aborted' (stop).
  async function performReplan(step, idx, { errMsg, reason, loopBreak } = {}) {
    if (replanCount >= maxReplans) {
      haltReason = loopBreak
        ? `loop guard: ${reason} — and replan budget exhausted (${maxReplans})`
        : `replan budget exhausted (${maxReplans}) after step ${step.step}`;
      emit({ type: 'policy:abort', step: step.step, reason: haltReason });
      return 'aborted';
    }
    replanCount += 1;
    emit({ type: 'policy:replan', attempt: replanCount, of: maxReplans, step: step.step, reason: reason || errMsg, loopBreak: !!loopBreak });
    const done = record.filter((r) => r.ok).map((r) => r.tool).join(', ') || 'nothing yet';
    const remainingGoal = loopBreak
      ? `${goal}\n\nYou are BREAKING A LOOP. The previous approach kept calling ${step.tool} `
        + `without making progress (${reason}). Already completed (do not repeat): ${done}. Plan ONLY the `
        + `remaining work using a DIFFERENT tool or approach — do not repeat ${step.tool} the same way.`
      : `${goal}\n\nYou are REPLANNING the remaining work after a failure. `
        + `Already completed (do not repeat): ${done}. The failed step was ${step.tool} `
        + `("${step.description || ''}") with error: ${errMsg}. Plan ONLY the remaining work to `
        + `achieve the goal, using a different tool or approach where the previous one failed.`;
    let rp;
    try { rp = await replan(remainingGoal); } catch (e) { rp = { ok: false, error: e.message }; }
    const fresh = (rp && rp.ok && Array.isArray(rp.steps)) ? rp.steps.filter((s) => s.valid !== false) : [];
    if (!fresh.length) {
      // HARD LIMIT: no catalog tool can accomplish the remaining work. Stop and
      // say so plainly. There is NO code-generation fallback — ever.
      haltReason = (rp && rp.infeasible) || (rp && rp.error)
        || 'no catalog tool can accomplish the remaining work';
      emit({ type: 'policy:abort', step: step.step, reason: haltReason, noToolFallback: true });
      return 'aborted';
    }
    // Renumber the fresh steps to continue after the completed ones, then splice
    // them in place of the failed/looping step and everything after it.
    const offset = idx > 0 ? (steps[idx - 1].step || idx) : 0;
    const renum = fresh.map((s) => ({
      ...s,
      step: (s.step || 0) + offset,
      depends_on: (s.depends_on || []).map((d) => d + offset),
    }));
    steps.splice(idx, steps.length - idx, ...renum);
    emit({ type: 'policy:replanned', insertedAt: idx, newSteps: renum.length });
    return 'replanned';
  }

  // Apply the error policy to a failed step at index `idx`. Returns an action
  // token: 'retry' (re-run same step), 'skip' (advance), 'replanned' (steps
  // spliced — re-run from idx), or 'aborted' (stop).
  async function onFailure(step, idx, errMsg) {
    let decision = 'retry', reason = '';
    try { ({ decision, reason } = await classify(step, errMsg)); }
    catch (_) { decision = 'retry'; reason = 'classifier error'; }
    emit({ type: 'policy:classified', step: step.step, decision, reason, error: errMsg });

    // A critical step may NEVER be silently skipped — force a replan instead.
    if (decision === 'skip' && step.critical) {
      emit({ type: 'policy:override', step: step.step, from: 'skip', to: 'replan', why: 'critical step cannot be skipped' });
      decision = 'replan';
    }

    if (decision === 'retry') {
      const used = retries[step.step] || 0;
      if (used < maxRetries) {
        retries[step.step] = used + 1;
        const backoff = 400 * (used + 1);
        emit({ type: 'policy:retry', step: step.step, attempt: used + 1, of: maxRetries, backoffMs: backoff, reason });
        await new Promise((r) => setTimeout(r, backoff));
        return 'retry';
      }
      emit({ type: 'policy:retry-exhausted', step: step.step, after: maxRetries });
      decision = step.critical ? 'replan' : 'skip';  // escalate
    }

    if (decision === 'skip') {
      emit({ type: 'step:skipped', step: step.step, tool: step.tool, reason: `policy:skip — ${reason}` });
      record.push({ step: step.step, tool: step.tool, skipped: true, reason: `skip: ${reason || errMsg}` });
      return 'skip';
    }

    if (decision === 'replan') {
      return performReplan(step, idx, { errMsg, reason });
    }

    // abort
    haltReason = reason || errMsg;
    emit({ type: 'policy:abort', step: step.step, reason: haltReason });
    return 'aborted';
  }

  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    const base = {
      step: step.step, tool: step.tool, side_effect: step.side_effect,
      critical: !!step.critical, description: step.description || '',
    };

    // Invalid step = the plan referenced something with no usable catalog tool/
    // params. Route through the policy (which will replan or abort) — never crash.
    if (step.valid === false) {
      emit({ type: 'step:error', ...base, error: 'invalid step — no usable catalog tool/params' });
      const act = await onFailure(step, i, 'invalid step — no usable catalog tool for this action');
      if (act === 'aborted') { aborted = true; break; }
      if (act === 'skip') { i += 1; continue; }
      continue; // 'retry' / 'replanned'
    }

    const isWrite = step.side_effect === catalog.SIDE_EFFECT.WRITE;

    // Resolve declared dependencies into params. Summary-injection (opt-in) only
    // applies to whole {{N}} refs feeding a NON-write tool — writes always get the
    // full, exact value so what's confirmed is what's sent.
    const inj = { summaries, useSummary: !isWrite && compress.injections === true, used: new Set() };
    const { params, problems } = resolveParams(step, results, inj);
    if (problems.length) {
      emit({ type: 'step:error', ...base, error: 'dependency resolution failed', problems });
      const act = await onFailure(step, i, 'dependency resolution failed: ' + problems.join('; '));
      if (act === 'aborted') { aborted = true; break; }
      if (act === 'skip') { i += 1; continue; }
      continue;
    }
    if (inj.used.size) emit({ type: 'context:summary-injected', ...base, fromSteps: Array.from(inj.used) });

    // Plan-preview mode: describe writes, never run them.
    if (isWrite && dryRun) {
      const message = `would perform: ${step.description || step.tool}`;
      emit({ type: 'step:would-perform', ...base, confirm: !!step.confirm, message, params });
      console.log(`  ${message}`);
      record.push({ step: step.step, tool: step.tool, wouldPerform: true });
      i += 1; continue;
    }

    // Confirmation gate — only for writes flagged confirm:true. Asked per action,
    // UNLESS the permission store already holds your explicit "always"/"never" for
    // this exact pattern (ask-once-generalize). See permission-store.js.
    if (isWrite && step.confirm === true) {
      const summary = summarizeAction(step, params);
      const gtool = catalog.getTool(step.tool);
      const remembered = permissions.lookup(gtool, params); // {decision,tier,entry} | null
      let gateDecision = null;  // 'execute' | 'skip'

      if (remembered && remembered.decision === 'deny') {
        // Remembered DENY → auto-skip, announced. (Skipping a write is always safe.)
        permissions.markUsed(remembered.entry);
        emit({ type: 'gate:auto-skipped', ...base, summary, reason: 'you told me to always decline this', entry: remembered.entry.key });
        record.push({ step: step.step, tool: step.tool, skipped: true, reason: 'auto-denied (remembered)' });
        i += 1; continue;
      }

      if (remembered && remembered.decision === 'approve' && remembered.tier === 'auto') {
        // Remembered AUTO approval → fire immediately, announced.
        permissions.markUsed(remembered.entry);
        emit({ type: 'gate:auto-approved', ...base, summary, tier: 'auto', entry: remembered.entry.key });
        gateDecision = 'execute';
      } else if (remembered && remembered.decision === 'approve' && remembered.tier === 'cancel-beat' && cancelBeat) {
        // Remembered CANCEL-BEAT → announce + open an interruptible window, then
        // fire unless stopped. Needs a wired canceller, else we fall through to ask.
        emit({ type: 'gate:cancel-beat', ...base, summary, tier: 'cancel-beat', seconds: opts.cancelBeatSeconds || 4, entry: remembered.entry.key });
        let cancelled = false;
        try { cancelled = await cancelBeat(step, summary, { params, seconds: opts.cancelBeatSeconds || 4 }); }
        catch (e) {
          haltReason = `cancel-beat failed at step ${step.step}: ${e.message}`;
          emit({ type: 'policy:abort', ...base, reason: haltReason }); aborted = true; break;
        }
        if (cancelled) {
          emit({ type: 'gate:cancel-beat-aborted', ...base, reason: 'stopped during the cancel window' });
          record.push({ step: step.step, tool: step.tool, skipped: true, reason: 'cancel-beat aborted' });
          i += 1; continue;
        }
        permissions.markUsed(remembered.entry);
        gateDecision = 'execute';
      }

      if (gateDecision === null) {
        // ASK — the normal gate. The confirmer may return a plain boolean (legacy)
        // or a rich object { approved, remember:'approve'|'deny', tier, promote }
        // capturing an explicit "always"/"never" + the tier you chose.
        emit({ type: 'step:confirm-request', ...base, summary, params, permission: { ceiling: ceilingFor(gtool) } });
        let raw;
        try {
          raw = await confirmer(step, summary, { params, permission: { ceiling: ceilingFor(gtool), entry: remembered && remembered.entry } });
        } catch (e) {
          // A confirmer failure is a system fault, not a tool failure — abort cleanly.
          haltReason = `confirmer failed at step ${step.step}: ${e.message}`;
          emit({ type: 'policy:abort', ...base, reason: haltReason });
          aborted = true; break;
        }
        const ans = (typeof raw === 'boolean') ? { approved: raw } : (raw || {});

        // Capture an explicit "always"/"never" if one was given.
        if (ans.remember === 'approve' || ans.remember === 'deny') {
          const res = permissions.remember(gtool, params, { decision: ans.remember, tier: ans.tier, promote: ans.promote });
          if (res.ok) emit({ type: 'gate:remembered', ...base, decision: ans.remember, tier: res.entry.tier, entry: res.entry.key });
          else emit({ type: 'gate:remember-refused', ...base, decision: ans.remember, reason: res.reason }); // e.g. ceiling 'never'
        }

        if (!ans.approved) {
          emit({ type: 'step:skipped', ...base, reason: 'declined' });
          record.push({ step: step.step, tool: step.tool, skipped: true, reason: 'declined' });
          i += 1; continue; // decline is a clean skip, reads + remaining steps still run
        }
        emit({ type: 'step:confirmed', ...base });
      }
    }

    // LOOP GUARD — last gate before we actually dispatch. Only real dispatches
    // (reads, confirmed writes, housekeeping writes) are checked/recorded; plan
    // previews and declined writes never reach here. A first trip WARNS and forces
    // a corrective replan (self-correction); a repeat trip HALTS the run. The halt
    // flows through the same aborted/haltReason path as every other stop, so the
    // existing spoken-failure cascade announces the reason out loud.
    {
      const tool = catalog.getTool(step.tool);
      const verdict = guard.check(step.tool, params, { isPolling: !!(tool && tool.polling) });
      if (verdict.action === 'warn') {
        emit({ type: 'loop_guard:warned', ...base, code: verdict.code, reason: verdict.reason });
        const act = await performReplan(step, i, { reason: verdict.reason, loopBreak: true });
        if (act === 'aborted') { aborted = true; break; }
        continue; // 'replanned' — re-run from i with the changed approach
      }
      if (verdict.action === 'halt') {
        haltReason = `loop guard: ${verdict.reason}`;
        emit({ type: 'loop_guard:tripped', ...base, code: verdict.code, reason: haltReason, halted: true });
        aborted = true; break;
      }
    }

    // Execute: a read, a confirmed write, or a confirm:false housekeeping write.
    emit({ type: 'step:start', ...base, params });
    const t0 = Date.now();
    let output, threw = null;
    try { output = await invoke(step.tool, params); }
    catch (e) { threw = e.message || String(e); }

    // Honest failure: a thrown error OR a tool that returns {ok:false}/{success:false}.
    const failedFlag = !threw && output && typeof output === 'object'
      && (output.ok === false || output.success === false);
    if (threw || failedFlag) {
      const errMsg = threw || (output.error || output.message || 'tool reported failure');
      record.push({ step: step.step, tool: step.tool, ok: false, error: errMsg });
      emit({ type: 'step:error', ...base, ms: Date.now() - t0, error: errMsg });
      const act = await onFailure(step, i, errMsg);
      if (act === 'aborted') { aborted = true; break; }
      if (act === 'skip') { i += 1; continue; }
      continue; // 'retry' (same step) or 'replanned' (spliced — re-run from i)
    }

    results[step.step] = output;   // full output ALWAYS kept — {{N.path}} refs resolve against it
    record.push({ step: step.step, tool: step.tool, ok: true, output, ...(isWrite ? { executed: true } : {}) });
    emit({ type: 'step:finish', ...base, ms: Date.now() - t0, ok: true, output: summarize(output) });

    // Observation summarization (opt-in): for a large TEXTUAL output, fold a short
    // 3B-model summary into `summaries[step]` so a downstream whole {{N}} injection
    // into a model tool doesn't blow up context. Best-effort; never blocks the run.
    if (compress.observations === true && !isWrite) {
      try {
        const r = await summarizeObservation(output, {
          threshold: compress.threshold || 2000,
          summarizer: compress.summarizer,
          ollamaUrl: CFG.ollamaUrl, model: CFG.fastModel,
        });
        if (r.summarized) {
          summaries[step.step] = r.text;
          emit({ type: 'context:observation-summarized', ...base, fromChars: r.originalLength, toChars: r.text.length, truncated: !!r.truncated });
        }
      } catch (_) { /* summarization is advisory — ignore failures */ }
    }
    i += 1;
  }

  emit({ type: 'plan:finish', aborted, haltReason, replans: replanCount, completed: Object.keys(results).length });
  return { ok: !aborted, results, record, aborted, halted: aborted, haltReason, replans: replanCount };
}

module.exports = {
  installToolTap, makeIpcInvoker, execute, defaultClassify, defaultReplan,
  resolveParams, marshalControl, summarizeAction, CFG, setShim,
};
