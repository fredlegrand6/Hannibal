// ─────────────────────────────────────────────────────────────────────────
// CLAUDE TOOLS — lets the Claude chat brain use Hannibal's real actions.
//
// Until now Claude could only talk; every action ran through the regex command
// parser or the Ollama planner. This module turns the tool CATALOG (the single
// source of truth, electron/services/agent/catalog.js) into Claude tool
// definitions, and runs each tool call Claude makes through the SAME executor
// the agent loop uses — so every existing safety rail still applies:
//   • read tools run straight away;
//   • confirm:true writes (mail, iMessage, trash, quit, browser clicks…) go
//     through the voice confirmation GATE — Fred hears the summary and says yes
//     or no; silence or a timeout means NO;
//   • the permission store's remembered "always"/"never" answers are honoured;
//   • tools the planner may never compose (planner_safe:false — mac.shell,
//     skills.execute, whatsapp.send) are NOT exposed to Claude either.
//
// Each Claude tool call becomes a one-step plan. Failures are handed back to
// Claude as an error result (no Ollama retry/replan), so Claude decides what to
// do next and tells Fred honestly.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const catalog = require('./agent/catalog');
const { execute } = require('./agent/executor');

// Tools that exist in the catalog but are not for Claude:
//   • voice/alias/preference/personality/behaviour/skill housekeeping — these
//     shape Hannibal's own settings and are driven by Fred's direct commands;
//   • memory.store and other renderer-only tools that have no main-side runner.
const EXCLUDED = new Set([
  'voice.tts', 'voice.config',
  'aliases.load', 'aliases.save',
  'preferences.load', 'preferences.save',
  'personality.load', 'personality.save',
  'behavior.list', 'behavior.log',
  'skills.list', 'skills.save',
  'memory.store',
  'reminders.save', 'timers.save', 'notes.save',   // whole-list replaces: one wrong call wipes the list
  'whatsapp.debugUi',
]);
// Renderer-side tools that DO have a main-side runner in the executor.
const MAIN_SIDE_SHIMS = new Set(['memory.query', 'translate.text']);

const MAX_RESULT_CHARS = 12000;   // keep huge reads (files, pages) from flooding the context

// Claude tool names allow [a-zA-Z0-9_-] only, so "mail.inbox" ⇄ "mail__inbox".
const toApiName = (name) => name.replace(/\./g, '__');
const fromApiName = (name) => String(name || '').replace(/__/g, '.');

// Where only some handlers exist (the always-on server has no Mac), only the
// tools whose channel is really there are offered. null = no restriction.
let availableChannels = null;
function setAvailableChannels(channels) {
  availableChannels = channels ? new Set(channels) : null;
  _defs = null;
}

function exposed(tool) {
  if (!tool || tool.planner_safe === false) return false;
  if (availableChannels && !(tool.via && tool.via.module) && !availableChannels.has(tool.via && tool.via.channel)) return false;
  if (EXCLUDED.has(tool.name)) return false;
  if (tool.via && tool.via.module && !MAIN_SIDE_SHIMS.has(tool.name)) return false;
  return true;
}

function paramSchema(p) {
  const s = {};
  switch (p.type) {
    case 'enum':    s.type = 'string'; if (Array.isArray(p.enum)) s.enum = p.enum; break;
    case 'number':  s.type = 'number'; break;
    case 'boolean': s.type = 'boolean'; break;
    case 'array':   s.type = 'array'; break;
    case 'object':  s.type = 'object'; break;
    default:        s.type = 'string';
  }
  if (p.desc) s.description = p.desc;
  return s;
}

function describe(tool) {
  let d = tool.description || tool.name;
  if (tool.side_effect === catalog.SIDE_EFFECT.WRITE) {
    d += tool.confirm ? ' [Changes something — Fred is asked to confirm by voice before it runs.]'
      : ' [Changes something small — runs without a prompt.]';
  }
  if (tool.returns) d += ` Returns: ${tool.returns}`;
  if (tool.note) d += ` Note: ${tool.note}`;
  return d;
}

// The tool list sent to Claude. Built once — it never changes at runtime, which
// keeps it inside the prompt cache.
let _defs = null;
function toolDefinitions() {
  if (_defs) return _defs;
  _defs = catalog.TOOLS.filter(exposed).map((t) => {
    const properties = {};
    const required = [];
    for (const p of t.params) {
      properties[p.name] = paramSchema(p);
      if (p.required) required.push(p.name);
    }
    return {
      name: toApiName(t.name),
      description: describe(t),
      input_schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    };
  });
  return _defs;
}

function stringify(out) {
  let s;
  try {
    if (out == null) s = String(out);
    else if (typeof out === 'string') s = out;
    else if (Buffer.isBuffer(out) || out instanceof Uint8Array) s = `<binary data, ${out.length} bytes>`;
    else s = JSON.stringify(out, (k, v) => (typeof v === 'string' && v.length > 4000 && /^[A-Za-z0-9+/=]+$/.test(v.slice(0, 200)))
      ? `<base64 data, ${v.length} chars>` : v);
  } catch (_) { s = '[result could not be serialized]'; }
  if (s.length > MAX_RESULT_CHARS) s = s.slice(0, MAX_RESULT_CHARS) + `… [truncated, ${s.length} chars total]`;
  return s;
}

// Screen / camera tools return frames as base64 (b64, images[], frames[]).
// Those go back to Claude as real image content so it can actually look.
const MAX_IMAGES = 3;
function mediaType(b64) {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('R0lG')) return 'image/gif';
  if (b64.startsWith('UklG')) return 'image/webp';
  return null;
}
function toolResultContent(out) {
  if (!out || typeof out !== 'object' || Array.isArray(out) || Buffer.isBuffer(out)) return stringify(out);
  const frames = [];
  const rest = {};
  for (const [k, v] of Object.entries(out)) {
    const list = k === 'b64' ? [v] : (k === 'images' || k === 'frames') && Array.isArray(v) ? v : null;
    if (list && list.every((x) => typeof x === 'string')) {
      for (const x of list) if (mediaType(x) && !frames.includes(x)) frames.push(x);
      if (list.some((x) => !mediaType(x))) rest[k] = v;   // not an image we recognise → keep as data
      continue;
    }
    rest[k] = v;
  }
  if (!frames.length) return stringify(out);
  const shown = frames.slice(0, MAX_IMAGES);
  return [
    ...shown.map((data) => ({ type: 'image', source: { type: 'base64', media_type: mediaType(data), data } })),
    { type: 'text', text: stringify({ ...rest, frames_attached: shown.length, frames_total: frames.length }) },
  ];
}

// Run one Claude tool call through the real executor + gate.
// opts: { confirmer, emit, invoke, permissions } — passed straight to execute().
// -> { content: string, is_error: boolean, tool: string, status }
async function runTool(apiName, input, opts = {}) {
  const name = fromApiName(apiName);
  const tool = catalog.getTool(name);
  if (!tool || !exposed(tool)) {
    return { tool: name, status: 'unknown', is_error: true, content: `Tool "${name}" is not available.` };
  }
  const params = (input && typeof input === 'object') ? input : {};
  const allowed = new Set(tool.params.map((p) => p.name));
  for (const k of Object.keys(params)) if (!allowed.has(k)) delete params[k];
  const missing = tool.params.filter((p) => p.required && (params[p.name] === undefined || params[p.name] === ''));
  if (missing.length) {
    return { tool: name, status: 'invalid', is_error: true, content: `Missing required parameter(s): ${missing.map((p) => p.name).join(', ')}.` };
  }

  const step = {
    step: 1, tool: name, params, depends_on: [],
    description: tool.description, side_effect: tool.side_effect,
    // Fail safe: a write is gated unless the catalog explicitly says confirm:false.
    ...(tool.side_effect === catalog.SIDE_EFFECT.WRITE ? { confirm: tool.confirm !== false } : {}),
  };
  let res;
  try {
    res = await execute({ goal: `[claude] ${name}`, steps: [step] }, {
      ...opts,
      // A failure goes straight back to Claude: no Ollama classifier, no retry, no replan.
      classify: async () => ({ decision: 'skip', reason: 'reported back to Claude' }),
      replan: async () => null,
      maxRetries: 0,
      maxReplans: 0,
    });
  } catch (e) {
    return { tool: name, status: 'error', is_error: true, content: `The tool crashed: ${e.message}` };
  }

  const rec = (res.record || []).find((r) => r.step === 1) || {};
  if (rec.ok) return { tool: name, status: 'ok', is_error: false, content: toolResultContent(rec.output) };
  if (rec.skipped && /declined|auto-denied|cancel-beat/.test(rec.reason || '')) {
    return { tool: name, status: 'declined', is_error: false,
      content: 'Fred did NOT approve this action, so it was not done. Do not retry it unless he asks again.' };
  }
  const why = rec.error || rec.reason || res.haltReason || 'unknown error';
  return { tool: name, status: 'error', is_error: true, content: `The action failed: ${why}` };
}

const enabled = () => !/^(0|false|off|no)$/i.test(process.env.HANNIBAL_CLAUDE_TOOLS || '');

module.exports = { toolDefinitions, runTool, setAvailableChannels, toApiName, fromApiName, exposed, enabled, stringify, toolResultContent, mediaType };

// `node electron/services/claude-tools.js` lists what Claude can use (no app needed).
if (require.main === module) {
  const defs = toolDefinitions();
  console.log(`${defs.length} tools exposed to Claude:`);
  console.log(defs.map((d) => '  ' + fromApiName(d.name)).join('\n'));
}
