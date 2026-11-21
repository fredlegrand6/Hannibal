// STT SERVER — Hannibal's ears, fast and sharp.
//
// Same contract as the old HoloAssistant whisper-server.js (so nothing else has
// to change): POST /transcribe?language=<code> with the recorded audio as the
// body → {success, transcript}. GET /health → {status:'ok', engine}.
//
// What is different:
//   • whisper.cpp's own `whisper-server` runs ONCE in the background with the
//     model loaded on the Mac's GPU (Metal). The old server started whisper-cli
//     per sentence, loading the model from disk every time.
//   • The best model on disk is used: large-v3-turbo when present (much better
//     at "Hannibal", Dutch and French), otherwise the old small model.
//   • No per-sentence Python VAD: Hannibal's live silero VAD already decided
//     there was speech. Whisper's own non-speech suppression drops the
//     "*Multiple people talking*" / "[BLANK_AUDIO]" style lines.
//   • The prompt "Hannibal" nudges Whisper to spell his name right.
//
// Run: node electron/services/stt-server.js   (main.js starts it)
// Env: WHISPER_MODEL, STT_PORT (8765), STT_ENGINE_PORT (8767),
//      WHISPER_SERVER_BIN, FFMPEG, HANNIBAL_STT_PROMPT, HANNIBAL_SPEAKER_CHECK=1
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.STT_PORT || 8765);
const ENGINE_PORT = Number(process.env.STT_ENGINE_PORT || 8767);
const BIN = process.env.WHISPER_SERVER_BIN || '/opt/homebrew/bin/whisper-server';
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const MODEL_DIR = '/Users/Shared/HoloAssistant/models/whisper';
const PROMPT = process.env.HANNIBAL_STT_PROMPT || 'Hannibal';
const ALLOWED_LANGS = new Set(['auto', 'en', 'nl', 'fr', 'de', 'es', 'it', 'pt']);

function log(...a) { try { console.log('[stt]', ...a); } catch (_) {} }

// Best model first. An explicit WHISPER_MODEL wins only if it is not the old
// default small model (main.js used to force that one).
function pickModel(env = process.env, exists = fs.existsSync) {
  const preferred = ['ggml-large-v3-turbo.bin', 'ggml-large-v3-turbo-q8_0.bin', 'ggml-large-v3-turbo-q5_0.bin', 'ggml-medium.bin', 'ggml-small.bin', 'ggml-small.en.bin']
    .map((f) => path.join(MODEL_DIR, f));
  const asked = env.WHISPER_MODEL;
  if (asked && exists(asked) && !/ggml-small(\.en)?\.bin$/.test(asked)) return asked;
  return preferred.find((p) => exists(p)) || asked || preferred[4];
}

// Lines Whisper writes for non-speech; never treat them as something Fred said.
function cleanTranscript(text) {
  let t = String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')          // [BLANK_AUDIO], [Music]
    .replace(/\*[^*]*\*/g, ' ')           // *Multiple people talking*
    .replace(/\((?:music|applause|laughter|silence|inaudible|background noise)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(?:thank you\.?|thanks for watching!?|you|\.+)$/i.test(t)) t = '';   // classic silence hallucinations
  return t;
}

// ── the engine (whisper.cpp server, model stays loaded) ──
let engine = null, engineReady = false, model = pickModel();
function startEngine() {
  if (engine) return;
  engineReady = false;
  const args = ['-m', model, '--host', '127.0.0.1', '--port', String(ENGINE_PORT),
    '-t', String(Math.max(4, Math.min(8, os.cpus().length - 2))), '-nt', '-sns', '--prompt', PROMPT];
  log('engine starting:', path.basename(model));
  engine = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const onOut = (d) => {
    const s = d.toString();
    if (/listening at|server is listening|HTTP server listening/i.test(s)) { engineReady = true; log('engine ready'); }
    if (/error|failed/i.test(s) && !/ggml_metal/i.test(s)) log(s.trim().slice(0, 300));
  };
  engine.stdout.on('data', onOut);
  engine.stderr.on('data', onOut);
  engine.on('exit', (code) => {
    log('engine exited', code);
    engine = null; engineReady = false;
    setTimeout(startEngine, 2000);    // keep the ears on
  });
  engine.on('error', (e) => log('engine spawn error', e.message));
}

async function waitEngine(ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (engineReady) return true;
    try { const r = await fetch(`http://127.0.0.1:${ENGINE_PORT}/`, { signal: AbortSignal.timeout(500) }); if (r) { engineReady = true; return true; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// Any recorded format (webm/opus from the renderer, wav, ogg) → 16 kHz mono wav.
function toWav16k(buf) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-nostdin', '-loglevel', 'error', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1']);
    const out = []; let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg: ' + err.trim().slice(0, 200)))));
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
}

// Optional: only answer Fred's voice (old HoloAssistant voiceprint check).
function speakerOk(wav) {
  const print = '/Users/Shared/HoloAssistant/voiceprint/fred_voiceprint.pt';
  if (process.env.HANNIBAL_SPEAKER_CHECK !== '1' || !fs.existsSync(print)) return true;
  const f = path.join(os.tmpdir(), `hannibal-spk-${Date.now()}.wav`);
  fs.writeFileSync(f, wav);
  const r = require('child_process').spawnSync('/opt/homebrew/bin/python3', ['/Users/Shared/HoloAssistant/ui/verify-speaker.py', f], { timeout: 15000 });
  fs.unlink(f, () => {});
  return r.status !== 1;
}

async function transcribe(audio, language) {
  const t0 = Date.now();
  const wav = await toWav16k(audio);
  if (wav.length < 16000) return { text: '', ms: Date.now() - t0 };     // < ~0.5 s of audio
  if (!speakerOk(wav)) { log('speaker rejected (not Fred)'); return { text: '', ms: Date.now() - t0 }; }
  if (!(await waitEngine())) throw new Error('speech engine not ready');
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('language', language);
  form.append('prompt', PROMPT);
  form.append('temperature', '0.0');
  form.append('response_format', 'json');
  const r = await fetch(`http://127.0.0.1:${ENGINE_PORT}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `engine HTTP ${r.status}`);
  return { text: cleanTranscript(j.text), ms: Date.now() - t0 };
}

function createServer() {
  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { status: 'ok', engine: 'hannibal-stt', model: path.basename(model), ready: engineReady });
    if (req.method !== 'POST' || url.pathname !== '/transcribe') { res.writeHead(404); res.end('Not found'); return; }
    let language = (url.searchParams.get('language') || 'en').toLowerCase().trim();
    if (!ALLOWED_LANGS.has(language)) language = 'en';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const { text, ms } = await transcribe(Buffer.concat(chunks), language);
        log(`✅ Transcript (${ms} ms, ${language}): "${text}"`);
        send(200, { success: true, transcript: text });
      } catch (e) {
        log('❌', e.message);
        send(500, { success: false, error: e.message });
      }
    });
  });
}

if (require.main === module) {
  startEngine();
  createServer().listen(PORT, '127.0.0.1', () => log(`listening on http://127.0.0.1:${PORT} (model ${path.basename(model)})`));
  const stop = () => { try { engine && engine.removeAllListeners('exit') && engine.kill(); } catch (_) {} process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.stdout.on('error', () => {}); process.stderr.on('error', () => {});
}

module.exports = { pickModel, cleanTranscript };
