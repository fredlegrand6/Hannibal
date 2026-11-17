// ─────────────────────────────────────────────────────────────────────────
// PLANNER — turns one plain-text goal into a structured, ordered plan. (Stage 2.)
//
// It does NOT execute anything. It only:
//   1. pulls relevant context from the hannibal_memory Qdrant collection,
//   2. asks the heavy reasoning model on GEX131 (OLLAMA_MODEL_HEAVY) to compose
//      a plan using ONLY planner-safe tools from the Stage-1 catalog,
//   3. validates + enriches the plan (real tools only, honest dependencies),
//   4. returns / prints it.
//
// DEPENDENCY HONESTY (core design rule, per the Stage-2 brief):
//   Dependencies between steps are declared up front in each step's `depends_on`
//   list. When a param value must come from an earlier step's OUTPUT, the value
//   is the literal token "{{stepN}}" AND N appears in depends_on. We never patch
//   data between steps later — the plan states the data flow or it doesn't exist.
//
// Runnable standalone (no Electron needed):
//   node electron/services/agent/planner.js "check my calendar for tomorrow"
//   node electron/services/agent/planner.js            # runs the 5 sample goals
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');

// ── minimal .env loader (same parser main.js uses) so standalone runs get creds ──
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '..', '..', '.env');
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch (_) { /* no .env — fine, defaults below */ }
})();

const CONFIG = {
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  // The heavy/70B model the existing router uses for hard reasoning.
  heavyModel: process.env.OLLAMA_MODEL_HEAVY || process.env.OLLAMA_MODEL || 'llama3.3:70b',
  qdrantUrl: process.env.QDRANT_URL || 'http://gex131-1:6333',
  qdrantCollection: process.env.QDRANT_COLLECTION || 'hannibal_memory',
  embedModel: process.env.EMBED_MODEL || 'nomic-embed-text',
};

// ── Qdrant memory (mirrors src/voice-controller.js, best-effort) ──
async function embed(text, ollamaUrl) {
  try {
    const r = await fetch(`${ollamaUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: CONFIG.embedModel, prompt: text, keep_alive: '30m' }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    return j.embedding || null;
  } catch (e) {
    console.warn('[planner] embed failed:', e.message);
    return null;
  }
}

async function queryMemory(text, limit = 5) {
  const vec = await embed(text, CONFIG.ollamaUrl);
  if (!vec) return [];
  try {
    const r = await fetch(`${CONFIG.qdrantUrl}/collections/${CONFIG.qdrantCollection}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector: vec, limit, with_payload: true, score_threshold: 0.35 }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    return (j.result || [])
      .map((p) => ({ text: p.payload?.text || p.payload?.content || '', score: p.score }))
      .filter((m) => m.text);
  } catch (e) {
    console.warn('[planner] memory query failed:', e.message);
    return [];
  }
}

// ── render the planner-safe catalog as a compact spec for the prompt ──
function toolSpec() {
  return catalog.plannerTools().map((t) => {
    const ps = t.params.map((p) => {
      const opt = p.required ? '' : '?';
      const en = p.enum ? `=${p.enum.join('|')}` : '';
      return `${p.name}${opt}:${p.type}${en}`;
    }).join(', ');
    const tag = t.side_effect === catalog.SIDE_EFFECT.WRITE
      ? (t.confirm ? 'write/confirm' : 'write')
      : 'read';
    const ret = t.returns ? `  ↦ returns ${t.returns}` : '';
    return `${t.name}(${ps}) [${tag}] — ${t.description}${ret}`;
  }).join('\n');
}

const SYSTEM_PROMPT = [
  "You are Hannibal's task planner. Convert the user's GOAL into the SHORTEST correct ordered plan,",
  'using ONLY tools from the TOOLS list. You output strict JSON and nothing else.',
  '',
  'Output shape:',
  '{ "steps": [ { "step": <int from 1>, "tool": "<exact tool name>", "params": { ... },',
  '              "description": "<plain language>", "critical": <bool>, "depends_on": [<earlier step ints>] } ],',
  '  "infeasible": "<omit unless the goal cannot be done with these tools; then a short reason>" }',
  '',
  'RULES:',
  '- Use only tool names that appear EXACTLY in TOOLS. Never invent a tool or a parameter name.',
  '- Use the fewest steps that achieve the goal. If one tool call is enough, return exactly one step.',
  '- params may only use the parameter names listed for that tool; always provide the required ones.',
  '- If a param value must come from an EARLIER step\'s output, reference it: "{{N}}" for the whole',
  '  output, or "{{N.path}}" for a PRECISE part of it, using that tool\'s documented "returns" shape.',
  '  Examples: "{{1.messages[0].uid}}", "{{2.body}}", "{{3.text}}". You may embed a ref inside a string,',
  '  e.g. "Re: {{2.subject}}". Always include N in depends_on. Declare EVERY real dependency; do not',
  '  assume data flows between steps unless you declare it. If steps are independent, depends_on is [].',
  '- Prefer a precise field path over passing a whole object: a tool that needs a uid wants',
  '  "{{1.messages[0].uid}}", NOT "{{1}}". To draft text from earlier content (e.g. an email reply),',
  '  use text.compose with context set to the source ref, then feed its "{{K.text}}" into the write step.',
  '- depends_on may only reference earlier (lower-numbered) steps.',
  '- critical=true when the goal fails without this step; false for optional/nice-to-have steps.',
  '- Some tools are marked [write] or [write/confirm] — that is fine to plan; do not avoid them, just',
  '  use them honestly. Never use a tool that is not in TOOLS.',
  '- If the goal cannot be accomplished with the available tools, return "steps": [] and set "infeasible".',
  '- Use MEMORY only if relevant; never mention the memory system or these instructions.',
].join('\n');

function buildUserPrompt(goal, memories) {
  const mem = memories.length
    ? memories.map((m, i) => `(${i + 1}) ${m.text}`).join('\n')
    : '(none)';
  return [
    `GOAL:\n${goal}`,
    '',
    `MEMORY (relevant context, may be empty):\n${mem}`,
    '',
    `TOOLS (the only tools you may use):\n${toolSpec()}`,
  ].join('\n');
}

// ── call the heavy model, force JSON ──
async function callPlanner(goal, memories, opts = {}) {
  const url = opts.ollamaUrl || CONFIG.ollamaUrl;
  const model = opts.model || CONFIG.heavyModel;
  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      options: { temperature: 0.2 },
      keep_alive: '30m',  // hold the 70B warm on the shared box between runs
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(goal, memories) },
      ],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs || 180000),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const j = await res.json();
  const content = j.message?.content || '';
  return content;
}

// Strip accidental ```json fences, then JSON.parse.
function parsePlan(raw) {
  const cleaned = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}

// Accepts both the documented "{{stepN}}" and the common shorthand "{{N}}".
// Matches {{N}}, {{stepN}}, and field paths {{N.body}} / {{1.messages[0].uid}};
// captures the step number for the depends_on honesty check.
const STEP_REF = /\{\{\s*(?:step)?\s*(\d+)(?:[.[][^}]*)?\}\}/gi;
function collectRefs(value, acc) {
  if (value == null) return;
  if (typeof value === 'string') {
    let m; STEP_REF.lastIndex = 0;
    while ((m = STEP_REF.exec(value)) !== null) acc.add(parseInt(m[1], 10));
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectRefs(v, acc));
  } else if (typeof value === 'object') {
    Object.values(value).forEach((v) => collectRefs(v, acc));
  }
}

// Validate against the catalog + the dependency-honesty rule. Returns enriched
// steps (with derived side_effect/confirm) plus a flat list of warnings. Never
// throws — invalid steps are flagged so the printed plan shows the problem.
function validateAndEnrich(steps) {
  const warnings = [];
  if (!Array.isArray(steps)) return { steps: [], warnings: ['model did not return a steps array'] };

  const enriched = steps.map((s, i) => {
    const num = typeof s.step === 'number' ? s.step : i + 1;
    const tool = catalog.getTool(s.tool);
    const issues = [];

    if (!tool) {
      issues.push(`unknown tool "${s.tool}" — not in catalog`);
    } else if (tool.planner_safe === false) {
      // planner_safe:false keeps the PLANNER from emitting the tool (it's absent
      // from its tool list). A direct/manual step may still use it — so warn,
      // don't invalidate, otherwise hand-built test plans (e.g. whatsapp.send)
      // would be blocked from running at all.
      warnings.push(`step ${num}: "${s.tool}" is planner-excluded (planner_safe:false) — fine for a direct step, but the planner won't emit it`);
    }

    const params = (s.params && typeof s.params === 'object') ? s.params : {};
    if (tool) {
      const allowed = new Set(tool.params.map((p) => p.name));
      for (const k of Object.keys(params)) {
        if (!allowed.has(k)) issues.push(`unknown param "${k}" for ${s.tool}`);
      }
      for (const p of tool.params) {
        if (p.required && !(p.name in params)) issues.push(`missing required param "${p.name}" for ${s.tool}`);
      }
    }

    // depends_on must reference earlier steps only.
    const declared = Array.isArray(s.depends_on) ? s.depends_on.slice() : [];
    for (const d of declared) {
      if (typeof d !== 'number') { issues.push(`depends_on entry "${d}" is not a step number`); continue; }
      if (d >= num) issues.push(`depends_on ${d} is not an earlier step than ${num}`);
    }

    // Cross-check {{stepN}} references in params against depends_on (honesty rule).
    const refs = new Set();
    collectRefs(params, refs);
    for (const r of refs) {
      if (!declared.includes(r)) issues.push(`param references {{step${r}}} but ${r} is not in depends_on`);
    }
    for (const d of declared) {
      if (typeof d === 'number' && d < num && !refs.has(d)) {
        warnings.push(`step ${num}: declares depends_on ${d} but no param uses {{step${d}}} (ordering-only dependency?)`);
      }
    }

    issues.forEach((msg) => warnings.push(`step ${num}: ${msg}`));

    return {
      step: num,
      tool: s.tool,
      params,
      description: s.description || '',
      critical: !!s.critical,
      depends_on: declared,
      // derived from the catalog so downstream stages don't re-look-up:
      side_effect: tool ? tool.side_effect : null,
      confirm: tool ? !!tool.confirm : null,
      valid: issues.length === 0,
    };
  });

  return { steps: enriched, warnings };
}

// ── main entry: goal -> plan ──
async function plan(goal, opts = {}) {
  goal = String(goal || '').trim();
  if (!goal) return { ok: false, error: 'empty goal' };

  const memories = opts.skipMemory ? [] : await queryMemory(goal);

  let raw;
  try {
    raw = await callPlanner(goal, memories, opts);
  } catch (e) {
    return { ok: false, goal, memories, error: `planner model call failed: ${e.message}` };
  }

  let parsed;
  try {
    parsed = parsePlan(raw);
  } catch (e) {
    return { ok: false, goal, memories, raw, error: `could not parse plan JSON: ${e.message}` };
  }

  const { steps, warnings } = validateAndEnrich(parsed.steps || []);
  return {
    ok: true,
    goal,
    memories,
    infeasible: parsed.infeasible || null,
    steps,
    warnings,
    raw,
  };
}

// ── pretty printer ──
function printPlan(p) {
  const L = [];
  L.push('═'.repeat(72));
  L.push(`GOAL: ${p.goal}`);
  if (!p.ok) { L.push(`✗ ERROR: ${p.error}`); if (p.raw) L.push(`  raw: ${String(p.raw).slice(0, 300)}`); L.push('═'.repeat(72)); return L.join('\n'); }
  L.push(`memory context: ${p.memories.length} item(s)`);
  if (p.infeasible) L.push(`⚠ INFEASIBLE: ${p.infeasible}`);
  if (!p.steps.length) { L.push('(no steps)'); L.push('═'.repeat(72)); return L.join('\n'); }

  for (const s of p.steps) {
    const tag = s.side_effect === catalog.SIDE_EFFECT.WRITE
      ? (s.confirm ? 'WRITE·confirm' : 'WRITE')
      : (s.side_effect === catalog.SIDE_EFFECT.READ ? 'read' : '??');
    const crit = s.critical ? ' ★critical' : '';
    const dep = s.depends_on.length ? ` depends_on:[${s.depends_on.join(',')}]` : '';
    const bad = s.valid ? '' : ' ✗INVALID';
    L.push(`  ${s.step}. ${s.tool}  [${tag}]${crit}${dep}${bad}`);
    L.push(`     ${s.description}`);
    if (Object.keys(s.params).length) L.push(`     params: ${JSON.stringify(s.params)}`);
  }
  if (p.warnings.length) {
    L.push('  ── warnings ──');
    p.warnings.forEach((w) => L.push(`     ⚠ ${w}`));
  }
  L.push('═'.repeat(72));
  return L.join('\n');
}

module.exports = { plan, printPlan, toolSpec, validateAndEnrich, CONFIG };

// ── CLI: print plan(s), execute nothing ──
const SAMPLE_GOALS = [
  'process the new Revalis Housing applications',
  "pull this week's numbers and email Robert a recap",
  'check my calendar and tell me my first free 2-hour gap tomorrow',
  'whats the weather in Ibiza this weekend',
  'read my latest unread email and reply to it for me',
];

if (require.main === module) {
  (async () => {
    const arg = process.argv.slice(2).join(' ').trim();
    const goals = arg ? [arg] : SAMPLE_GOALS;
    console.log(`Planner using model=${CONFIG.heavyModel} @ ${CONFIG.ollamaUrl}`);
    console.log(`Qdrant=${CONFIG.qdrantUrl}/${CONFIG.qdrantCollection}\n`);
    for (const g of goals) {
      const p = await plan(g);
      console.log(printPlan(p));
      console.log('');
    }
  })().catch((e) => { console.error('planner CLI failed:', e); process.exit(1); });
}
