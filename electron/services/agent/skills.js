// ─────────────────────────────────────────────────────────────────────────
// SKILLS — named, parameterized, multi-step capabilities. (Phase 3, mined from
// agentskills.io and rebuilt native.)
//
// THE FRAMING: a Hannibal skill = a frozen, parameterized PLAN made of catalog
// tools. The executor already walks plans (with {{N.path}} dependency passing,
// the confirmation gate, the permission store, LoopGuard, and the error policy),
// so a skill is just a saved sub-plan. We do NOT build a second runtime — a
// skill compiles to executor steps and runs through execute().
//
// SOURCE OF TRUTH: skills are DATA, not code — one TOML file per skill under
// data/skills/, legible and diffable (same honesty principle as the permission
// store). A skill may reference ONLY catalog tools, so it introduces no raw new
// capability and cannot escape the gate: every write step inside a skill still
// gates and still consults the permission store.
//
// SUBSUME (Fred's call): the old shell-command skill notion becomes ONE step-
// type inside this model. A step may be `tool = "…"` (a catalog tool) OR
// `shell = "…"` — a shell step compiles to the catalog's `mac.shell` tool, which
// is confirm:true and planner_safe:false, so a shell step is automatically gated
// and a skill that contains one is planner-excluded. One skill model, escape
// hatch preserved.
//
// NOT YET (follow-up pass, per Fred): the agentskills.io SKILL.md importer + tool-
// translation map. Author-your-own is proven first; import lands after the core.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');
const planner = require('./planner');           // reuse validateAndEnrich — ONE validation path
const { execute } = require('./executor');
const { parse } = require('./toml-lite');

const SKILLS_DIR = path.join(__dirname, '..', '..', '..', 'data', 'skills');

// {{name}} substitution for SKILL INPUT params only. The regex requires a leading
// letter/underscore, so numeric step refs ({{1}}, {{2.body}}) are never touched —
// those stay for the executor to resolve from prior step outputs.
const NAMED_REF = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g;
const SOLE_NAMED = /^\s*\{\{\s*([A-Za-z_]\w*)\s*\}\}\s*$/;

function substParams(value, paramMap) {
  if (typeof value === 'string') {
    const sole = value.match(SOLE_NAMED);
    if (sole) return (sole[1] in paramMap) ? paramMap[sole[1]] : value;  // whole-value → keep type
    return value.replace(NAMED_REF, (m, n) => (n in paramMap ? String(paramMap[n]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => substParams(v, paramMap));
  if (value && typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value)) o[k] = substParams(value[k], paramMap);
    return o;
  }
  return value;
}

// Raw parsed TOML → a normalized manifest.
function toManifest(parsed, sourceFile) {
  const s = (parsed && parsed.skill) || {};
  return {
    name: s.name || '',
    description: s.description || '',
    version: s.version || '0.1.0',
    params: Array.isArray(s.params) ? s.params : [],
    steps: Array.isArray(s.steps) ? s.steps : [],
    sourceFile: sourceFile || null,
  };
}

// Compile a skill (+ args) into a runnable plan, reusing the planner's validator
// so the dependency-honesty contract is identical to a hand-built plan.
function compileSkill(manifest, args = {}) {
  const paramMap = {};
  const missingParams = [];
  for (const p of (manifest.params || [])) {
    if (args[p.name] !== undefined) paramMap[p.name] = args[p.name];
    else if (p.default !== undefined) paramMap[p.name] = p.default;
    else if (p.required) missingParams.push(p.name);
  }

  const rawSteps = (manifest.steps || []).map((s, idx) => {
    const isShell = s.shell !== undefined && s.shell !== null;
    const tool = isShell ? 'mac.shell' : s.tool;                     // subsume: shell → mac.shell
    const params = isShell ? { command: substParams(s.shell, paramMap) } : substParams(s.params || {}, paramMap);
    const step = { step: idx + 1, tool, params, description: s.description || '', critical: !!s.critical };
    if (Array.isArray(s.depends_on)) step.depends_on = s.depends_on;
    return step;
  });

  const { steps, warnings } = planner.validateAndEnrich(rawSteps);
  return {
    ok: missingParams.length === 0,
    missingParams,
    goal: manifest.description || `skill: ${manifest.name}`,
    steps,
    warnings,
    skill: manifest.name,
  };
}

// Static analysis for listing/discovery: required tools, runnability, whether the
// planner may compose it (no shell / no planner_safe:false tool), missing tools.
function enrich(manifest) {
  const compiled = compileSkill(manifest, {});                       // empty args fine for static checks
  const tools = [...new Set(compiled.steps.map((s) => s.tool))];
  const missingTools = tools.filter((t) => !catalog.getTool(t));
  const invalid = compiled.steps.filter((s) => s.valid === false);
  const plannerSafe = compiled.steps.every((s) => {
    const t = catalog.getTool(s.tool);
    return t && t.planner_safe !== false;
  });
  return {
    ...manifest,
    requires: tools,
    runnable: invalid.length === 0 && missingTools.length === 0,
    missingTools,
    planner_safe: plannerSafe,
    stepCount: compiled.steps.length,
    warnings: compiled.warnings,
  };
}

function loadSkills(dir = SKILLS_DIR) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.toml')); }
  catch (_) { return []; }                                           // no dir yet → no skills
  const out = [];
  for (const f of files.sort()) {
    try {
      const m = toManifest(parse(fs.readFileSync(path.join(dir, f), 'utf8')), f);
      if (!m.name) { out.push({ name: f.replace(/\.toml$/, ''), sourceFile: f, runnable: false, error: 'missing [skill].name', steps: [], params: [], requires: [] }); continue; }
      out.push(enrich(m));
    } catch (e) {
      out.push({ name: f.replace(/\.toml$/, ''), sourceFile: f, runnable: false, error: `parse failed: ${e.message}`, steps: [], params: [], requires: [] });
    }
  }
  return out;
}

function getSkill(name, dir) { return loadSkills(dir).find((s) => s.name === name) || null; }
function listSkills(dir) { return loadSkills(dir); }

// One-line discovery summary (for a future planner-composition pass). Unrunnable
// skills are shown with WHY, never silently hidden.
function skillCatalogText(dir) {
  return loadSkills(dir).map((s) => {
    const ps = (s.params || []).map((p) => (p.required ? p.name : `${p.name}?`)).join(', ');
    const tag = s.runnable ? (s.planner_safe ? '' : ' [planner-excluded]') : ` [UNRUNNABLE: ${s.error || 'missing ' + (s.missingTools || []).join(', ')}]`;
    return `${s.name}(${ps})${tag} — ${s.description}`;
  }).join('\n');
}

// Run a skill end-to-end: load (if a name) → enrich → compile → execute.
// Returns the executor's result, or an honest {ok:false,…} before running.
async function runSkill(nameOrManifest, args = {}, opts = {}) {
  const manifest = (typeof nameOrManifest === 'string')
    ? getSkill(nameOrManifest, opts.dir)
    : enrich(nameOrManifest);
  if (!manifest) return { ok: false, error: `unknown skill "${nameOrManifest}"` };
  if (manifest.runnable === false) {
    return { ok: false, error: `skill "${manifest.name}" is not runnable`, missingTools: manifest.missingTools, parseError: manifest.error, warnings: manifest.warnings };
  }
  const compiled = compileSkill(manifest, args);
  if (!compiled.ok) return { ok: false, error: `missing required params: ${compiled.missingParams.join(', ')}` };
  if (compiled.steps.some((s) => s.valid === false)) return { ok: false, infeasible: true, warnings: compiled.warnings };
  return execute({ goal: compiled.goal, steps: compiled.steps }, opts);
}

module.exports = { loadSkills, listSkills, getSkill, compileSkill, enrich, runSkill, skillCatalogText, toManifest, substParams, SKILLS_DIR };
