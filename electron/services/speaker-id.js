// SPEAKER ID — who is talking: Fred, someone else, or not sure.
//
// Fred enrols his voice once (a short guided round of five sentences, "Hannibal,
// learn my voice"). Each sentence becomes a voiceprint (speaker-embed.py, an
// ECAPA speaker model that runs on the Mac); their average is Fred's voice.
// From then on every clip the speech server hears is compared with it:
//   fred    — clearly Fred's voice            (with a confidence, e.g. 0.92)
//   other   — clearly someone else (a guest, Robert, the TV, a call on speaker)
//   unknown — too short to tell (a "yes", "ja"), in between, or not enrolled yet
// "unknown" is treated like Fred everywhere, so before enrolment, and for short
// answers, Hannibal behaves exactly as he did before.
//
// Stored locally, never on GitHub (data/ is committed, so it is NOT in data/):
//   voiceprint  ~/Library/Application Support/Hannibal/voiceprint.json   (HANNIBAL_VOICEPRINT)
//   recent tags ~/Library/Logs/Hannibal/who-said.log                     (HANNIBAL_WHO_LOG)
// Tuning: HANNIBAL_SPEAKER_MID (similarity where fred/other meet, default 0.35),
//         HANNIBAL_SPEAKER_ID=0 turns tagging off (everything "unknown").
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIM = 192;
const MIN_TAG_SECONDS = 1.0;      // shorter than this ("yes", "ja") → unknown
const MIN_ENROL_SECONDS = 1.5;    // an enrolment sentence must be at least this long
const MIN_ENROL_SAMPLES = 3;
const PAD_SECONDS = 0.7;          // stt-server's toWav16k adds 0.4 s before + 0.3 s after
const MAX_LOG_LINES = 2000;

// The sentences Fred reads during enrolment: his four languages, so his voice
// is learned the way he really talks.
const ENROL_SENTENCES = [
  'Hannibal, what is on my calendar for tomorrow morning?',
  'Send a message to Jay that I will be there in twenty minutes.',
  'Goedemorgen Hannibal, zet de muziek wat zachter alsjeblieft.',
  'Bonjour, rappelle-moi d\'appeler Jean-Marc cet après-midi.',
  'Buenos días, ¿qué tiempo va a hacer hoy en Ibiza?',
];

const defaultPrintFile = () => process.env.HANNIBAL_VOICEPRINT
  || path.join(os.homedir(), 'Library', 'Application Support', 'Hannibal', 'voiceprint.json');
const defaultLogFile = () => process.env.HANNIBAL_WHO_LOG
  || path.join(os.homedir(), 'Library', 'Logs', 'Hannibal', 'who-said.log');

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

function mean(vectors) {
  const out = new Array(vectors[0].length).fill(0);
  for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i] / vectors.length;
  const n = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
  return out.map((x) => x / n);
}

// Seconds of real audio in a 16 kHz mono 16-bit wav from toWav16k (padding removed).
function speechSeconds(wav) {
  const bytes = Buffer.isBuffer(wav) ? wav.length : 0;
  return Math.max(0, (bytes - 44) / 32000 - PAD_SECONDS);
}

// Similarity with Fred's voice → how likely it is Fred (0..1), and the tag.
// Measured on Fred's Mac 2026-11-22: Fred vs Fred ≈ 0.56 (two single clips),
// other voices ≈ -0.08 … 0.21. The curve is centred between them.
function classify(sim, { mid = Number(process.env.HANNIBAL_SPEAKER_MID) || 0.35, slope = 12 } = {}) {
  const pFred = 1 / (1 + Math.exp(-(sim - mid) * slope));
  if (pFred >= 0.75) return { tag: 'fred', score: round2(pFred) };
  if (pFred <= 0.25) return { tag: 'other', score: round2(1 - pFred) };
  return { tag: 'unknown', score: round2(Math.max(pFred, 1 - pFred)), why: 'in between' };
}
const round2 = (x) => Math.round(x * 100) / 100;

// The Python helper, kept running so each clip costs ~30 ms, not a model load.
function createPythonEmbedder({
  python = process.env.HANNIBAL_PYTHON || '/opt/homebrew/bin/python3',
  script = path.join(__dirname, 'speaker-embed.py'),
  log = (...a) => console.log('[speaker]', ...a),
  timeoutMs = 8000,
} = {}) {
  let child = null, buf = '', seq = 0, dead = false;
  const waiting = new Map();
  function start() {
    if (child || dead) return;
    try { child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { dead = true; log('could not start:', e.message); return; }
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const j = JSON.parse(line); const w = waiting.get(j.id); if (w) { waiting.delete(j.id); w(j); } } catch (_) {}
      }
    });
    child.stderr.on('data', (d) => { const s = String(d).trim(); if (/\[speaker-embed\]/.test(s)) log(s.replace(/^.*\[speaker-embed\]\s*/, '')); });
    child.on('error', (e) => { log('helper error:', e.message); dead = true; });
    child.on('exit', (code) => {
      child = null;
      for (const [, w] of waiting) w({ ok: false, error: `helper exited ${code}` });
      waiting.clear();
      if (!dead) setTimeout(start, 3000);
    });
    child.stdin.on('error', () => {});
  }
  function ask(msg) {
    start();
    if (!child) return Promise.resolve({ ok: false, error: 'helper not running' });
    const id = ++seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
      waiting.set(id, (j) => { clearTimeout(t); resolve(j); });
      child.stdin.write(JSON.stringify({ id, ...msg }) + '\n');
    });
  }
  async function embed(wav) {
    const f = path.join(os.tmpdir(), `hannibal-who-${process.pid}-${Date.now()}-${seq}.wav`);
    try {
      fs.writeFileSync(f, wav);
      const j = await ask({ wav: f });
      return j && j.ok && Array.isArray(j.emb) ? j.emb : null;
    } finally { fs.unlink(f, () => {}); }
  }
  // Wait until the model is loaded (first time: downloaded). Long timeout on purpose.
  function ready(ms = 180000) {
    start();
    if (!child) return Promise.resolve(false);
    const id = ++seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => { waiting.delete(id); resolve(false); }, ms);
      waiting.set(id, (j) => { clearTimeout(t); resolve(!!(j && j.ok)); });
      child.stdin.write(JSON.stringify({ id, ping: true }) + '\n');
    });
  }
  function stop() { dead = true; try { child && child.kill(); } catch (_) {} }
  return { embed, start, ready, stop };
}

function createSpeakerId({
  embed = null,                         // async (wav) → number[] | null
  printFile = defaultPrintFile(),
  logFile = defaultLogFile(),
  now = () => new Date(),
  enabled = process.env.HANNIBAL_SPEAKER_ID !== '0',
  log = (...a) => console.log('[speaker]', ...a),
} = {}) {
  let print = null;
  let enrol = null;                     // { samples: [emb], startedAt }
  let writes = 0;

  function loadPrint() {
    try {
      const j = JSON.parse(fs.readFileSync(printFile, 'utf8'));
      if (Array.isArray(j.centroid) && j.centroid.length === DIM) print = j;
    } catch (_) { print = null; }
  }
  loadPrint();

  function status() {
    return {
      ok: true, enabled, enrolled: !!print,
      samples: print ? print.samples : 0,
      enrolledAt: print ? print.created : null,
      quality: print ? print.quality : null,
      enrolling: enrol ? { count: enrol.samples.length, of: ENROL_SENTENCES.length } : null,
      sentences: ENROL_SENTENCES,
    };
  }

  // One clip → { tag, score, sim?, why? }. Never throws.
  async function tag(wav) {
    if (!enabled) return { tag: 'unknown', score: 0, why: 'off' };
    if (!print) return { tag: 'unknown', score: 0, why: 'not enrolled' };
    const secs = speechSeconds(wav);
    if (secs < MIN_TAG_SECONDS) return { tag: 'unknown', score: 0, why: 'too short' };
    let emb = null;
    try { emb = embed ? await embed(wav) : null; } catch (_) { emb = null; }
    if (!emb) return { tag: 'unknown', score: 0, why: 'voice model not available' };
    const sim = cosine(emb, print.centroid);
    return { ...classify(sim), sim: round2(sim) };
  }

  function enrolStart() { enrol = { samples: [], startedAt: now().toISOString() }; return { ok: true, sentences: ENROL_SENTENCES }; }

  async function enrolAdd(wav) {
    if (!enrol) enrolStart();
    const secs = speechSeconds(wav);
    if (secs < MIN_ENROL_SECONDS) return { ok: false, why: 'too short', seconds: round2(secs), count: enrol.samples.length };
    let emb = null;
    try { emb = embed ? await embed(wav) : null; } catch (_) { emb = null; }
    if (!emb) return { ok: false, why: 'voice model not available', count: enrol.samples.length };
    enrol.samples.push(emb);
    return { ok: true, seconds: round2(secs), count: enrol.samples.length, of: ENROL_SENTENCES.length };
  }

  function enrolFinish() {
    if (!enrol || enrol.samples.length < MIN_ENROL_SAMPLES) {
      return { ok: false, why: `need at least ${MIN_ENROL_SAMPLES} good sentences`, count: enrol ? enrol.samples.length : 0 };
    }
    const centroid = mean(enrol.samples);
    const sims = enrol.samples.map((s) => cosine(s, centroid));
    const quality = round2(sims.reduce((a, b) => a + b, 0) / sims.length);
    const next = { version: 1, model: 'speechbrain/spkrec-ecapa-voxceleb', created: now().toISOString(), samples: enrol.samples.length, quality, centroid: centroid.map((x) => Math.round(x * 1e5) / 1e5) };
    try {
      fs.mkdirSync(path.dirname(printFile), { recursive: true });
      fs.writeFileSync(printFile, JSON.stringify(next));
    } catch (e) { return { ok: false, why: `could not save: ${e.message}` }; }
    print = next; enrol = null;
    log(`Fred's voice learned from ${next.samples} sentences (match ${quality})`);
    return { ok: true, samples: next.samples, quality };
  }

  function enrolCancel() { enrol = null; return { ok: true }; }
  function forget() { print = null; enrol = null; try { fs.unlinkSync(printFile); } catch (_) {} return { ok: true }; }

  // The renderer reports what it decided for each line (who, for me?, what it did).
  function record(d = {}) {
    const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
    const e = {
      t: now().toISOString(),
      text: clean(d.text, 120),
      speaker: ['fred', 'other', 'unknown'].includes(d.speaker) ? d.speaker : 'unknown',
      speakerScore: Number(d.speakerScore) || 0,
      addressed: clean(d.addressed, 10) || 'no',
      addressedScore: Number(d.addressedScore) || 0,
      action: clean(d.action, 10) || 'silent',
      why: clean(d.why, 120),
    };
    if (d.lang) e.lang = clean(d.lang, 5);
    if (d.sim != null) e.sim = Number(d.sim);
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify(e) + '\n');
      if (++writes % 100 === 0) {
        const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
        if (lines.length > MAX_LOG_LINES) fs.writeFileSync(logFile, lines.slice(-MAX_LOG_LINES).join('\n') + '\n');
      }
    } catch (_) {}
    return e;
  }

  function recent(n = 20) {
    let items = [];
    try {
      items = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    } catch (_) {}
    items = items.slice(-Math.max(1, Math.min(200, Number(n) || 20)));
    const by = (k, v) => items.filter((x) => x[k] === v).length;
    const summary = items.length
      ? `Last ${items.length} lines: ${by('speaker', 'fred')} Fred, ${by('speaker', 'other')} someone else, ${by('speaker', 'unknown')} not sure; `
        + `answered ${by('action', 'answer') + by('action', 'brief')}, stayed quiet on ${by('action', 'silent')}.`
      : 'No lines tagged yet.';
    return { ok: true, enrolled: !!print, summary, tags: items };
  }

  return { status, tag, enrolStart, enrolAdd, enrolFinish, enrolCancel, forget, record, recent, printFile, logFile };
}

module.exports = { createSpeakerId, createPythonEmbedder, classify, cosine, mean, speechSeconds, ENROL_SENTENCES, MIN_TAG_SECONDS, MIN_ENROL_SECONDS };
