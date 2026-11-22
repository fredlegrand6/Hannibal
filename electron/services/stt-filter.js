// STT FILTER — keeps made-up and garbled speech away from Hannibal's brain.
//
// Whisper invents text from silence and noise, and mishears short phrases.
// Four checks, in the order the audio goes through them:
//   1. audioVerdict   — a clip with (almost) no voice in it never reaches Whisper.
//   2. keepSegments   — Whisper's own scores: a segment it thinks is no speech
//                       (no_speech_prob > 0.6 and avg_logprob < -1.0) or a repeat
//                       loop (compression_ratio > 2.4) is dropped.
//   3. applyBlocklist — known phantom lines (stt-blocklist.txt): a whole match is
//                       dropped, a partial one is cut out.
//   4. rateConfidence — what is left gets high / medium / low, which travels
//                       with the transcript so Hannibal asks instead of guessing.
// Every drop is logged with its reason (logDrop), so the numbers can be tuned.
// Pure functions, no Electron: node electron/services/test-stt-filter.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const LIMITS = (env = process.env) => ({
  minSpeechMs: num(env.HANNIBAL_STT_MIN_SPEECH_MS, 250),    // voiced time under this = no speech
  voiceRms: num(env.HANNIBAL_STT_VOICE_RMS, 300),           // a 20 ms frame louder than this counts as voice (16-bit)
  peakRms: num(env.HANNIBAL_STT_PEAK_RMS, 500),             // the loudest frame must reach this
  noSpeechProb: num(env.HANNIBAL_STT_NO_SPEECH, 0.6),
  minLogprob: num(env.HANNIBAL_STT_MIN_LOGPROB, -1.0),
  maxCompression: num(env.HANNIBAL_STT_MAX_COMPRESSION, 2.4),
});

// ── 1. silence check on 16 kHz mono 16-bit PCM (a wav buffer is fine: the
//       44-byte header is skipped) ──
function audioStats(buf, rate = 16000) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const start = b.length > 44 && b.toString('ascii', 0, 4) === 'RIFF' ? 44 : 0;
  const frame = Math.round(rate * 0.02);                    // 20 ms
  const rms = [];
  for (let i = start; i + frame * 2 <= b.length; i += frame * 2) {
    let s = 0;
    for (let j = 0; j < frame; j++) { const v = b.readInt16LE(i + j * 2); s += v * v; }
    rms.push(Math.sqrt(s / frame));
  }
  return { frames: rms, frameMs: 20, peak: rms.reduce((m, v) => Math.max(m, v), 0) };
}

function audioVerdict(buf, limits = LIMITS()) {
  const { frames, frameMs, peak } = audioStats(buf);
  // Voice = louder than the fixed floor AND clearly above this clip's own
  // background: the quietest fifth of ALL frames, true silence included, so a
  // clean or noise-suppressed recording keeps a floor near 0 instead of one
  // taken from the speech itself. Capped, so steady music or a fan can't push
  // the bar above normal speech.
  const sorted = frames.slice().sort((a, b) => a - b);
  const floor = sorted.length ? sorted[Math.floor(sorted.length * 0.2)] : 0;
  // (and never above half the loudest frame, so one long even sound still counts)
  const bar = Math.max(limits.voiceRms, Math.min(floor * 2, 1500, peak * 0.5));
  const speechMs = frames.filter((v) => v >= bar).length * frameMs;
  const info = { speechMs, peak: Math.round(peak), floor: Math.round(floor) };
  if (peak < limits.peakRms) return { keep: false, reason: 'silence', detail: `too quiet (peak ${info.peak})`, ...info };
  if (speechMs < limits.minSpeechMs) return { keep: false, reason: 'silence', detail: `only ${speechMs} ms of voice`, ...info };
  return { keep: true, ...info };
}

// ── 2. Whisper's own confidence, per segment ──
// whisper.cpp's verbose_json gives avg_logprob and no_speech_prob; the
// compression ratio is worked out here the same way OpenAI's Whisper does it
// (text bytes / zlib bytes), so a "the the the the..." loop scores high.
function compressionRatio(text) {
  const b = Buffer.from(String(text || ''), 'utf8');
  if (b.length < 12) return 1;
  return b.length / zlib.deflateSync(b).length;
}

function segmentsOf(j) {
  if (j && Array.isArray(j.segments) && j.segments.length) {
    return j.segments.map((s) => ({
      text: String(s.text || ''),
      avg_logprob: num(s.avg_logprob, undefined),
      no_speech_prob: num(s.no_speech_prob, undefined),
      compression_ratio: num(s.compression_ratio, compressionRatio(s.text)),
    }));
  }
  return [{ text: String((j && j.text) || ''), compression_ratio: compressionRatio(j && j.text) }];
}

function keepSegments(segments, limits = LIMITS()) {
  const kept = []; const dropped = [];
  for (const s of segments) {
    if (!s.text.trim()) continue;
    if (s.no_speech_prob > limits.noSpeechProb && s.avg_logprob < limits.minLogprob) dropped.push({ ...s, reason: 'low confidence', detail: 'no speech' });
    else if (s.compression_ratio > limits.maxCompression) dropped.push({ ...s, reason: 'low confidence', detail: 'repeat loop' });
    else kept.push(s);
  }
  return { kept, dropped };
}

// ── 3. phantom lines ──
const BLOCKLIST_FILE = path.join(__dirname, 'stt-blocklist.txt');
function loadBlocklist(file = BLOCKLIST_FILE) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.startsWith('^') ? { start: true, phrase: norm(l.slice(1)) } : { start: false, phrase: norm(l) }))
    .filter((e) => e.phrase);
}

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

// Lines that are nothing but "you", dots or music notes.
const JUNK_ONLY = /^(?:\s|you|\.|…|♪|♫|♬|🎵|🎶|-)*$/iu;

function applyBlocklist(text, list = loadBlocklist()) {
  const removed = [];
  const parts = String(text || '').split(/(?<=[.!?])\s+/);
  const keep = [];
  for (const part of parts) {
    let p = part;
    const n = norm(p);
    if (JUNK_ONLY.test(p) || !n) { if (p.trim()) removed.push(p.trim()); continue; }
    let hit = false;
    for (const e of list) {
      if (e.start ? n.startsWith(e.phrase) : similarity(n, e.phrase) >= 0.85) { hit = true; break; }
      // a longer known phrase inside a real sentence: cut just that phrase
      if (!e.start && e.phrase.split(' ').length >= 3 && n.includes(e.phrase)) {
        const words = e.phrase.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const re = new RegExp(words.join('[^\\p{L}\\p{N}]+') + '[.!?,]?', 'iu');
        const cut = p.replace(re, ' ').replace(/\s+/g, ' ').trim();
        if (cut !== p.trim()) { removed.push(e.phrase); p = cut; }
      }
    }
    if (hit) { removed.push(p.trim()); continue; }
    if (norm(p)) keep.push(p.trim());
  }
  let out = keep.join(' ').trim();
  if (JUNK_ONLY.test(out)) out = '';
  return { text: out, removed };
}

// ── 4. confidence for the brain ──
function rateConfidence(segments) {
  const scored = segments.filter((s) => typeof s.avg_logprob === 'number');
  const words = segments.map((s) => s.text).join(' ').trim().split(/\s+/).filter(Boolean).length;
  if (!scored.length) return 'medium';                       // Whisper gave no scores: don't claim either way
  const total = scored.reduce((a, s) => a + Math.max(1, s.text.length), 0);
  const avg = scored.reduce((a, s) => a + s.avg_logprob * Math.max(1, s.text.length), 0) / total;
  const noSpeech = Math.max(...scored.map((s) => (typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0)));
  if (avg < -0.8 || noSpeech > 0.5) return 'low';
  if (words <= 3 && avg < -0.5) return 'low';                // a short line Whisper wasn't sure of
  if (avg >= -0.4 && noSpeech < 0.3) return 'high';
  return 'medium';
}

// Whole pipeline after Whisper answered: engine json → {text, confidence, dropped[]}
function judge(j, opts = {}) {
  const limits = opts.limits || LIMITS();
  const { kept, dropped } = keepSegments(segmentsOf(j), limits);
  const drops = dropped.map((d) => ({ reason: d.reason, detail: d.detail, text: d.text.trim() }));
  const joined = kept.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
  const cleaned = (opts.clean || ((t) => t))(joined);
  const bl = applyBlocklist(cleaned, opts.blocklist || loadBlocklist());
  if (bl.removed.length) drops.push({ reason: 'blocklist', detail: bl.removed.join(' | '), text: cleaned });
  // A transcript that is only the hint words echoed back is Whisper filling silence.
  let text = bl.text;
  if (text && opts.prompt && isPromptEcho(text, opts.prompt)) { drops.push({ reason: 'blocklist', detail: 'hint words echoed', text }); text = ''; }
  return { text, confidence: text ? rateConfidence(kept) : null, dropped: drops };
}

// Echo = the whole line is a run of 4+ hint words in the hint's own order
// ("Hannibal, Fred, Mandy, Gaian"). "Hannibal, play Spotify" is a real command.
function isPromptEcho(text, prompt) {
  const words = norm(text).split(' ').filter(Boolean);
  if (words.length < 4) return false;
  const p = norm(prompt).split(' ').filter(Boolean);
  for (let i = 0; i + words.length <= p.length; i++) {
    if (words.every((w, k) => p[i + k] === w)) return true;
  }
  return false;
}

// ── logging: one line per drop, in the Hannibal logs folder ──
const LOG_FILE = process.env.HANNIBAL_STT_DROP_LOG || path.join(os.homedir(), 'Library', 'Logs', 'Hannibal', 'stt-dropped.log');
function logDrop(entry, log = console.log, file = LOG_FILE) {
  const line = { at: new Date().toISOString(), ...entry };
  try { log('[stt] dropped', `(${entry.reason})`, entry.detail || '', entry.text ? JSON.stringify(entry.text) : ''); } catch (_) {}
  if (!file) return;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(line) + '\n'); } catch (_) {}
}

module.exports = { LIMITS, audioStats, audioVerdict, compressionRatio, segmentsOf, keepSegments, loadBlocklist, applyBlocklist, similarity, norm, rateConfidence, judge, isPromptEcho, logDrop };
