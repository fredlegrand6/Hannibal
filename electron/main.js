const { app, BrowserWindow, ipcMain, screen, systemPreferences } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { registerControls } = require('./services/system-control');
const { startCcIngest, getSessions } = require('./services/cc-ingest');
// Agent loop (Stage 3): tap ipcMain.handle so the executor can invoke the same
// handlers the renderer triggers over IPC. MUST run before any handler registers
// — it only records (channel -> listener); handler behavior is unchanged.
const { installToolTap, makeIpcInvoker, execute: runPlan } = require('./services/agent/executor');
const skills = require('./services/agent/skills');
const { validateAndEnrich, plan: makePlan } = require('./services/agent/planner');
// Stage 7: Continuous Awareness — opt-in background screen-watch loop. Owns the
// cheap gates (perceptual hash → OCR → struggle math); the renderer owns the
// speak gate. Default OFF; started only via the awareness:start IPC.
const { createAwareness } = require('./services/awareness');
// Presence loop (first autonomous layer): a proactive heartbeat that looks around,
// notices things via the vision model, and speaks up unprompted (English). READ
// tools only — a hard write-filter in presence.js blocks every write/confirm tool.
// Default OFF; started via presence:control or HANNIBAL_PRESENCE_ENABLED.
const { createPresence } = require('./services/agent/presence');
// World Awareness (Stage 1): one read-only dual-dispatch tool — opens the
// WorldMonitor crypto view (eyes) + returns a live narrated read (ears).
const { registerWorld } = require('./services/world');
// Camera steering (pan/tilt/zoom/track) for the OBSBOT Tiny 3 over OSC → OBSBOT
// Center. The 'hands' beside vision.capture's 'eyes'. Reuses captureCameraFrame
// (defined below) for the camera.look composite — no second camera path.
const { registerCameraControl } = require('./services/camera-control');
// Chat brain: Claude API via the official SDK (streamed, prompt-cached). The
// renderer falls back to Ollama on GEX131 whenever this returns ok:false.
const claudeBrain = require('./services/claude-brain');
const claudeTools = require('./services/claude-tools');
const { registerFacts } = require('./services/memory-facts');
const { registerProactive } = require('./services/proactive');
const { createTelegramBridge, makeWhisperTranscriber } = require('./services/telegram');
const { createQdrantMemory } = require('./services/qdrant-memory');
installToolTap(ipcMain);

// Only ONE Hannibal at a time. Two copies fight over the mic, the wake word and
// port 8787 (and answer twice). A second launch just focuses the running one.
if (!app.requestSingleInstanceLock()) {
  console.log('[hannibal] already running — focusing the existing window');
  app.exit(0);
}
app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

registerProactive(ipcMain, {
  getWindow: () => win,
  // Briefs and reminders also reach Fred's phone (Telegram), wherever he is.
  onBrief: (text) => { if (telegram) telegram.notify(`☀️ Morning brief\n\n${text}`, { voice: true }).catch(() => {}); },
  onReminder: (message) => { if (telegram) telegram.notify(`⏰ Reminder: ${message}`).catch(() => {}); },
});   // morning brief + reminders.add/cancel/upcoming
registerFacts(ipcMain);   // 'facts:remember' / 'facts:forget' / 'facts:list' — saved facts Claude always knows
// 'llm:chat' → tokens stream back on 'llm:token'. Claude can also use Hannibal's
// actions: each tool call runs through the SAME executor + voice confirmation gate
// as the agent loop (claude-tools.js). Turn off with HANNIBAL_CLAUDE_TOOLS=0.
claudeBrain.registerClaudeBrain(ipcMain, {
  runTool: (name, input) => claudeTools.runTool(name, input, {
    confirmer: makeIpcConfirmer(),
    // Log only: the renderer's agent:progress narration belongs to agent:run plans,
    // and Claude narrates its own work.
    emit: (ev) => { if (/^step:(start|finish|error|skipped|confirm)/.test(ev.type)) console.log('[claude-tool]', ev.type, ev.tool || ''); },
  }),
  onToolEvent: (ev) => { try { win && win.webContents.send('llm:tool', ev); } catch (_) {} },
});
registerControls(ipcMain); // 'browser-action' + 'mac-control' IPC handlers
registerWorld(ipcMain);    // 'world:crypto' (after registerControls so EYES can reuse 'browser-action' open)
// The coordinator (single owner of the gimbal) is returned so we can stop its
// follow-watchdog on quit. See camera-coordinator.js.
const cameraCoordinator = registerCameraControl(ipcMain, { captureCameraFrame: (...a) => captureCameraFrame(...a) }); // 'camera:control'

let win;
let wakeProc = null;
let whisperProc = null;
let vadProc = null;     // streaming silero VAD sidecar
let ccIngestServer = null;
let awareness = null;   // Stage 7 engine, created in whenReady
let presence = null;    // autonomous presence loop, created in whenReady

// ── PATH: started from the Dock or at login, macOS gives the app a bare PATH
// (/usr/bin:/bin…), so child processes can't find Homebrew tools — the
// whisper-server then can't find ffmpeg and every utterance is dropped.
// start.sh exported this; do it here so every way of starting behaves the same.
{
  const extra = ['/opt/homebrew/bin', '/usr/local/bin'];
  const parts = String(process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':');
  process.env.PATH = [...extra.filter((d) => !parts.includes(d)), ...parts].join(':');
}

// ── load .env (simple KEY=VALUE parser, no dependency) ──
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch (_) { /* no .env — fine */ }
})();

// ── config (env-overridable) ──
const CONFIG = {
  pythonTTS:  process.env.HANNIBAL_PY      || '/opt/homebrew/bin/python3',     // has `requests`
  pythonWake: process.env.HANNIBAL_PY_WAKE || '/opt/homebrew/bin/python3.12',  // has picovoice
  node:       process.env.HANNIBAL_NODE    || '/opt/homebrew/bin/node',
  whisperScript: process.env.WHISPER_SCRIPT || '/Users/Shared/HoloAssistant/ui/whisper-server.js',
  whisperUrl: process.env.WHISPER_URL || 'http://127.0.0.1:8765',
  ollamaUrl:  process.env.OLLAMA_URL  || 'http://127.0.0.1:11434',
  // Multi-model router: most turns ("how are you") go to a small, instant model;
  // only complex requests escalate to the heavy 70b. Both env-overridable.
  ollamaModel:     process.env.OLLAMA_MODEL       || 'llama3.1:70b', // back-compat / legacy callers
  ollamaModelFast: process.env.OLLAMA_MODEL_FAST  || 'llama3.2:3b',  // quick chat (fallback: qwen2.5:7b)
  ollamaModelHeavy: process.env.OLLAMA_MODEL_HEAVY || process.env.OLLAMA_MODEL || 'llama3.3:70b', // reasoning/code
  ollamaModelVision: process.env.OLLAMA_MODEL_VISION || 'qwen2.5vl:7b', // screen + camera understanding
  cameraIndex: process.env.HANNIBAL_CAMERA_INDEX || '0', // avfoundation video device (see `ffmpeg -f avfoundation -list_devices true -i ""`)
  ffmpeg:     process.env.HANNIBAL_FFMPEG || '/opt/homebrew/bin/ffmpeg',
  // Qwen2.5-VL vision-token count scales with resolution, so latency tracks image
  // size hard: a raw retina screenshot (3456px) takes ~78s to encode, 1024px ~35s,
  // 768px ~18s. We downscale every captured frame to this long-edge before sending.
  // 1568px long edge = the detail Claude can actually use (read a label, see what's in a hand).
  visionMaxPx: process.env.HANNIBAL_VISION_MAX_PX || '1568',
  ttsScript:  path.join(__dirname, 'services', 'nova-tts.py'),
  wakeScript: path.join(__dirname, 'services', 'wakeword.py'),
  vadScript:  path.join(__dirname, 'services', 'vad-stream.py'), // streaming silero VAD (real speech/not-speech)
  searxngUrl: process.env.SEARXNG_URL || 'http://gex131-1:8888',
  // Qdrant long-term memory on GEX131, reached on the Tailscale IP. Needs
  // `tailscale serve --tcp=6333` on the server, exactly like Ollama on 11434.
  qdrantUrl: (process.env.QDRANT_URL || 'http://100.99.70.113:6333').replace(/\/+$/, ''),
  // ALWAYS-LISTEN: when on (default), the mic stays continuously open and silero
  // VAD alone decides utterance boundaries — no "Hey Hannibal" gate needed. Set
  // HANNIBAL_ALWAYS_LISTEN=0|false|off|no to restore the classic wake-word flow.
  alwaysListen: !/^(0|false|off|no)$/i.test(process.env.HANNIBAL_ALWAYS_LISTEN || ''),
};

function createWindow() {
  win = new BrowserWindow({
    frame: false,
    fullscreen: true,
    backgroundColor: '#06060C',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  // DevTools only on request (HANNIBAL_DEVTOOLS=1) — otherwise it covers the app.
  if (/^(1|true|yes|on)$/i.test(process.env.HANNIBAL_DEVTOOLS || '')) win.webContents.openDevTools({ mode: 'detach' });
  win.once('ready-to-show', () => win.show());
  // Page warnings/errors (failed speech playback, unreachable services…) into the
  // main log, so problems are visible without opening DevTools.
  win.webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error') console.log(`[page:${e.level}]`, String(e.message).slice(0, 400));
  });
  // The VAD sidecar is a main-process child that survives renderer reloads (Cmd+R),
  // so its one-shot VAD_READY is long gone by the time a reloaded renderer subscribes.
  // Re-announce current readiness on every load so silero authority latches every time.
  win.webContents.on('did-finish-load', () => { if (vadReadyState) sendVad({ type: 'ready' }); });
  win.on('closed', () => { win = null; });

  // Window-local keybindings (fire only when focused — no system-wide hijack):
  //   Esc → toggle fullscreen   Cmd+Q → quit   Cmd+R → reload
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (input.key === 'Escape') { win.setFullScreen(!win.isFullScreen()); event.preventDefault(); }
    else if (input.meta && key === 'q') { app.quit(); event.preventDefault(); }
    else if (input.meta && key === 'r') { win.reload(); event.preventDefault(); }
  });

  // grant mic access for the renderer's capture pipeline
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });
}

// ── WAKE WORD: spawn wakeword.py, relay "WAKE_WORD_DETECTED" to renderer ──
function startWakeWord() {
  wakeProc = spawn(CONFIG.pythonWake, [CONFIG.wakeScript], { env: process.env });
  wakeProc.stdout.on('data', (buf) => {
    const out = buf.toString();
    if (out.includes('WAKE_WORD_DETECTED')) {
      console.log('[wake] wake word detected');
      win && win.webContents.send('voice:wake');
    }
    for (const line of out.split('\n')) {   // status lines ("Listening…", mic errors) into the log
      if (line.trim() && !line.includes('WAKE_WORD_DETECTED')) console.log('[wake]', line.trim());
    }
  });
  wakeProc.stderr.on('data', (d) => console.log('[wake]', d.toString().trim()));
  wakeProc.on('close', (code) => {
    console.log('[wake] exited', code);
    wakeProc = null;
    if (!app.isQuiting) setTimeout(startWakeWord, 2000); // auto-restart
  });
  wakeProc.on('error', (e) => console.log('[wake] spawn error', e.message));
}

// ── STREAMING SILERO VAD: real speech/not-speech decision (knows voice from
// music, where a level meter cannot). Sidecar holds the model in memory and
// emits SPEECH_START / SPEECH_END lines; we relay them to the renderer, which
// uses them to close an utterance. Auto-restarts; renderer falls back to its
// level detector if this never reaches VAD_READY. ──
let vadReadyState = false;   // is the sidecar currently loaded? (re-announced to the renderer on reload)
function sendVad(ev) { try { win && win.webContents.send('voice:vad', ev); } catch (_) {} }
function startVad() {
  vadProc = spawn(CONFIG.pythonTTS, [CONFIG.vadScript], { env: process.env });
  let buf = '';
  vadProc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      if (line === 'SPEECH_START') sendVad({ type: 'start' });
      else if (line === 'SPEECH_END') sendVad({ type: 'end' });
      else if (line === 'VAD_READY') { console.log('[vad] ready'); vadReadyState = true; sendVad({ type: 'ready' }); }
      else if (line.startsWith('VAD_ERROR')) { console.log('[vad]', line); sendVad({ type: 'error', error: line }); }
      // PROB lines (VAD_DEBUG) are ignored here.
    }
  });
  vadProc.stderr.on('data', (d) => console.log('[vad]', d.toString().trim()));
  vadProc.on('close', (code) => {
    console.log('[vad] exited', code);
    vadProc = null;
    vadReadyState = false;
    sendVad({ type: 'error', error: `exited ${code}` });
    if (!app.isQuiting) setTimeout(startVad, 3000); // auto-restart
  });
  vadProc.on('error', (e) => console.log('[vad] spawn error', e.message));
}
// Renderer drives PAUSE/RESUME (during TTS) + live threshold tuning.
ipcMain.on('voice:vad-control', (_e, cmd) => {
  try { vadProc && vadProc.stdin.writable && vadProc.stdin.write(String(cmd) + '\n'); } catch (_) {}
});

// ── WHISPER: start V1's server (builtin-http, absolute model path) if not up ──
async function ensureWhisper() {
  const up = await ping(CONFIG.whisperUrl + '/health');
  if (up) { console.log('[whisper] already running'); return; }
  // Pass through the multilingual model path so the shared whisper-server
  // (default = ggml-small.en.bin for legacy callers) runs the Dutch/French-
  // capable model when launched by Hannibal. Env-overridable.
  const whisperEnv = {
    ...process.env,
    WHISPER_MODEL: process.env.WHISPER_MODEL || '/Users/Shared/HoloAssistant/models/whisper/ggml-small.bin',
  };
  whisperProc = spawn(CONFIG.node, [CONFIG.whisperScript], {
    cwd: path.dirname(CONFIG.whisperScript),   // so __dirname helpers resolve
    env: whisperEnv,
  });
  whisperProc.stdout.on('data', (d) => console.log('[whisper]', d.toString().trim()));
  whisperProc.stderr.on('data', (d) => console.log('[whisper]', d.toString().trim()));
  whisperProc.on('error', (e) => console.log('[whisper] spawn error', e.message));
}

function ping(url) {
  return fetch(url, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
}

// ── TTS: run nova-tts.py (text via stdin), return the MP3 BYTES to renderer.
// Renderer plays them through Web Audio so the brain can read amplitude. ──
function runTts(cmd, args, stdinText) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: process.env });
    let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch (_) {} reject(new Error('tts timed out')); }, 45000);
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error('tts failed: ' + err.trim().slice(0, 300)));
    });
    if (stdinText != null) { p.stdin.write(stdinText); p.stdin.end(); }
  });
}
// Hannibal's voice as an OGG/Opus voice note (for Telegram). ElevenLabs only:
// if it fails, no voice note is sent (the text reply already went out).
async function voiceNote(text) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mp3 = `/tmp/hannibal-vn-${stamp}.mp3`;
  const ogg = `/tmp/hannibal-vn-${stamp}.ogg`;
  try {
    await runTts(CONFIG.pythonTTS, [CONFIG.ttsScript, mp3], String(text || ''));
    await runTts(CONFIG.ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', mp3, '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', ogg], null);
    return fs.readFileSync(ogg);
  } finally { fs.unlink(mp3, () => {}); fs.unlink(ogg, () => {}); }
}

ipcMain.handle('voice:tts', async (_e, text) => {
  // Unique per call — two sentences requested in the same millisecond must not share a file.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let file = `/tmp/hannibal-tts-${stamp}.mp3`;
  try {
    await runTts(CONFIG.pythonTTS, [CONFIG.ttsScript, file], String(text || ''));   // ElevenLabs
  } catch (e) {
    // ElevenLabs unavailable (key, quota, network) — never stay silent: fall back
    // to the built-in macOS voice so the answer is still spoken out loud.
    console.warn('[tts] ElevenLabs failed, using the macOS voice instead:', e.message);
    file = `/tmp/hannibal-tts-${stamp}.wav`;
    await runTts('/usr/bin/say', ['-o', file, '--data-format=LEI16@22050', String(text || '')], null);
  }
  const buf = fs.readFileSync(file);
  fs.unlink(file, () => {});
  console.log(`[tts] ${file.endsWith('.mp3') ? 'ElevenLabs' : 'macOS voice'}: ${String(text || '').length} chars → ${buf.length} bytes of audio`);
  return buf; // arrives in renderer as a Uint8Array
});

// ── SYSTEM METRICS: ssh to GEX131, return a raw snapshot for the right-rail gauges.
// One ssh round-trip returns four @@-delimited sections. CPU% and NET rate are
// computed in the renderer from deltas between polls (cumulative counters here).
// nvidia-smi is attempted but the box's NVIDIA driver isn't currently loaded
// (Ollama is running on CPU), so gpu comes back null and the renderer shows it
// OFFLINE — the moment the driver is up, the same handler lights the GPU gauges. ──
const GEX131_SSH = process.env.GEX131_SSH_HOST || 'GEX131';
const METRICS_SCRIPT = [
  'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null || echo GPU_NA',
  'echo @@MEM; free -b | awk "/Mem:/{print \\$3, \\$2}"',
  'echo @@CPU; awk "/^cpu /{b=\\$2+\\$3+\\$4+\\$7+\\$8; print b, b+\\$5+\\$6}" /proc/stat',
  'echo @@NET; awk -F"[: ]+" "NR>2 && \\$2!=\\"lo\\"{rx+=\\$3; tx+=\\$11} END{print rx, tx}" /proc/net/dev',
  'echo @@UP; awk "{print int(\\$1)}" /proc/uptime',
].join('; ');

ipcMain.handle('system:metrics', async () => {
  try {
    const out = await new Promise((resolve, reject) => {
      const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', GEX131_SSH, METRICS_SCRIPT],
        { env: process.env });
      let so = '', se = '';
      p.stdout.on('data', (d) => { so += d; });
      p.stderr.on('data', (d) => { se += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(so) : reject(new Error(se || `ssh exit ${code}`))));
    });
    const [gpuRaw = '', memRaw = '', cpuRaw = '', netRaw = '', upRaw = ''] = out.split(/@@MEM|@@CPU|@@NET|@@UP/);
    const nums = (s) => s.trim().split(/[\s,]+/).map(Number);

    let gpu = null;
    if (!/GPU_NA/.test(gpuRaw) && gpuRaw.trim()) {
      const [util, vu, vt, temp] = nums(gpuRaw);
      if (Number.isFinite(util) && Number.isFinite(vt) && vt > 0) gpu = { util, vramUsedMB: vu, vramTotalMB: vt, temp };
    }
    const [memUsed, memTotal] = nums(memRaw);
    const [cpuBusy, cpuTotal] = nums(cpuRaw);
    const [netRx, netTx] = nums(netRaw);
    const [uptimeSec] = nums(upRaw);
    return { ok: true, ts: Date.now(), gpu,
      mem: { used: memUsed, total: memTotal },
      cpu: { busy: cpuBusy, total: cpuTotal },
      net: { rx: netRx, tx: netTx },
      uptime: Number.isFinite(uptimeSec) ? uptimeSec : null };
  } catch (e) {
    console.log('[metrics] ssh failed', e.message);
    return { ok: false, error: e.message };
  }
});

// ── CALENDAR: fetch today+tomorrow's events from Nextcloud over CalDAV. One
// REPORT (calendar-query) with a time-range filter returns matching VEVENTs as
// raw iCalendar, which we unfold + parse minimally (DTSTART/SUMMARY). Creds live
// in .env as an app password (never the main account password). ──
function parseICalEvents(xml, now) {
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const events = [];
  // pull each <...calendar-data>…</…calendar-data> block regardless of ns prefix
  const blocks = xml.match(/<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/g) || [];
  for (let raw of blocks) {
    const ics = unesc(raw.replace(/<[^>]*calendar-data[^>]*>/, '').replace(/<\/[^>]*calendar-data>/, ''))
      .replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');  // unfold continuation lines
    for (const vevent of ics.split('BEGIN:VEVENT').slice(1)) {
      const body = vevent.split('END:VEVENT')[0];
      const summary = (body.match(/\nSUMMARY[^:]*:(.*)/) || body.match(/^SUMMARY[^:]*:(.*)/) || [])[1];
      const dtLine = (body.match(/DTSTART([^:\n]*):([0-9TZ]+)/) || []);
      if (!dtLine[2]) continue;
      const params = dtLine[1] || '', v = dtLine[2];
      const allDay = /VALUE=DATE\b/.test(params) || /^\d{8}$/.test(v);
      let when, time;
      if (allDay) {
        when = new Date(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8));
        time = 'All day';
      } else if (/Z$/.test(v)) {                       // UTC → local
        when = new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13)));
        time = when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      } else {                                          // floating / TZID → treat as wall-clock
        when = new Date(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13));
        time = `${v.slice(9, 11)}:${v.slice(11, 13)}`;
      }
      events.push({ ts: when.getTime(), time, allDay, title: (summary || '(no title)').trim() });
    }
  }
  const todayKey = new Date(now); todayKey.setHours(0, 0, 0, 0);
  const dayMs = 864e5;
  return events
    .filter((e) => e.allDay || e.ts >= now.getTime() - 30 * 60 * 1000)   // drop past timed events (30m grace)
    .sort((a, b) => a.ts - b.ts)
    .map((e) => ({ ...e, day: Math.floor((e.ts - todayKey.getTime()) / dayMs) <= 0 ? 'today' : 'tomorrow' }));
}

ipcMain.handle('calendar:events', async () => {
  const base = (process.env.NEXTCLOUD_URL || '').replace(/\/$/, '');
  const user = process.env.NEXTCLOUD_USER, pw = process.env.NEXTCLOUD_APP_PW;
  const cal = process.env.NEXTCLOUD_CALENDAR || 'personal';
  if (!base || !user || !pw) return { ok: false, error: 'nextcloud creds missing' };
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 2);
  const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${fmt(start)}" end="${fmt(end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const url = `${base}/remote.php/dav/calendars/${encodeURIComponent(user)}/${cal}/`;
  try {
    const res = await fetch(url, {
      method: 'REPORT',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64'),
        Depth: '1', 'Content-Type': 'application/xml',
      },
      body, signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: `caldav ${res.status}` };
    return { ok: true, events: parseICalEvents(await res.text(), now) };
  } catch (e) {
    console.log('[calendar] caldav failed', e.message);
    return { ok: false, error: e.message };
  }
});

// ── MAIL: Zoho inbox summary over IMAP (stdlib imaplib via a spawned Python
// script — same pattern as TTS/wakeword, no npm deps). Returns unread count +
// the latest few messages for the left-rail Mail panel. ──
ipcMain.handle('mail:inbox', async () => {
  if (!process.env.ZOHO_APP_PW) return { ok: false, error: 'Zoho app password not set in .env' };
  try {
    const { so, se, code } = await new Promise((resolve) => {
      const p = spawn(CONFIG.pythonTTS, [path.join(__dirname, 'services', 'imap-mail.py')], { env: process.env });
      let so = '', se = '';
      p.stdout.on('data', (d) => { so += d; });
      p.stderr.on('data', (d) => { se += d; });
      p.on('error', (e) => resolve({ so: '', se: e.message, code: -1 }));
      p.on('close', (code) => resolve({ so, se, code }));
    });
    try {
      const j = JSON.parse(so.trim().split('\n').pop() || '{}');
      if (j.error) return { ok: false, error: j.error };
      return { ok: true, unread: j.unread || 0, messages: j.messages || [] };
    } catch (_) {
      return { ok: false, error: se.trim() || `mail script exit ${code}` };
    }
  } catch (e) {
    console.log('[mail] failed', e.message);
    return { ok: false, error: e.message };
  }
});

// ── MAIL: read full body of a specific message by IMAP UID ──
ipcMain.handle('mail:read-body', async (_e, uid) => {
  if (!process.env.ZOHO_APP_PW) return { ok: false, error: 'Zoho app password not set' };
  if (!uid) return { ok: false, error: 'No message UID provided' };
  try {
    const { so, se, code } = await new Promise((resolve) => {
      const p = spawn(CONFIG.pythonTTS, [
        path.join(__dirname, 'services', 'imap-read-body.py'), String(uid)
      ], { env: process.env });
      let so = '', se = '';
      p.stdout.on('data', (d) => { so += d; });
      p.stderr.on('data', (d) => { se += d; });
      p.on('error', (e) => resolve({ so: '', se: e.message, code: -1 }));
      p.on('close', (code) => resolve({ so, se, code }));
    });
    try {
      const j = JSON.parse(so.trim().split('\n').pop() || '{}');
      if (j.error) return { ok: false, error: j.error };
      return { ok: true, from: j.from, from_email: j.from_email || '', subject: j.subject, date: j.date, body: j.body };
    } catch (_) {
      return { ok: false, error: se.trim() || `read-body exit ${code}` };
    }
  } catch (e) {
    console.log('[mail] read-body failed', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('voice:config', () => ({
  whisperUrl: CONFIG.whisperUrl,
  ollamaUrl: CONFIG.ollamaUrl,
  ollamaModel: CONFIG.ollamaModel,
  ollamaModelFast: CONFIG.ollamaModelFast,
  ollamaModelHeavy: CONFIG.ollamaModelHeavy,
  ollamaModelVision: CONFIG.ollamaModelVision,
  alwaysListen: CONFIG.alwaysListen,
  qdrantUrl: CONFIG.qdrantUrl,
  qdrantApiKey: process.env.QDRANT_API_KEY || '',   // Qdrant on GEX131 requires it (api-key header)
  // Chat brain: Claude first (the key stays in main), Ollama on GEX131 as fallback.
  claudeEnabled: claudeBrain.enabled(),
  claudeModel: claudeBrain.model(),
  claudeTools: claudeBrain.toolsEnabled(),
  // Phase D — autonomous-speech arbiter knobs (renderer-side; live-tunable via env).
  arbiterGapMs:          parseInt(process.env.HANNIBAL_ARBITER_GAP_MS || '30000', 10),  // min gap between ANY two autonomous lines
  arbiterPreemptMs:      parseInt(process.env.HANNIBAL_ARBITER_PREEMPT_MS || '6000', 10), // higher-priority line may jump in this soon after a lower one
  arbiterFocusMs:        parseInt(process.env.HANNIBAL_ARBITER_FOCUS_MS || '20000', 10),  // suppress camera chit-chat if Fred worked on-screen within this window
  arbiterConversationMs: parseInt(process.env.HANNIBAL_ARBITER_CONVO_MS || '12000', 10),  // suppress camera chit-chat this soon after Fred spoke
}));

// ── SELF-LEARNING ALIASES ──
// data/aliases.json is the runtime source of truth for Whisper-misrecognition
// fixes (project names, contact names, command phrases). The renderer reads it
// on init and applies the substitutions in fixTranscript so every downstream
// path sees the canonical form. New aliases are written either explicitly
// ("add alias X for Y") or automatically when a fuzzy-match miss is confirmed
// ("Did you mean X?" → "yes"). The categories are organizational — both are
// applied as word-boundary replacements.
const ALIASES_PATH = path.join(__dirname, '..', 'data', 'aliases.json');
const BOOTSTRAP_ALIASES = {
  names: {
    // Project / brand names
    'rivalis': 'revalis', 'revallis': 'revalis', 'rivallis': 'revalis', 'ravalis': 'revalis',
    'suite sync': 'suitesynq', 'sweet sync': 'suitesynq', 'suite synq': 'suitesynq',
    'vak sync': 'vaksynq', 'vak synq': 'vaksynq',
    'zero chat': 'zerochat', 'block dive': 'blockdive',
    'my cannabis': 'mycannabisexchange',
    'prix dami': 'prixdami', 'date night': 'datenight',
    // Contact names (Whisper consistently mishears these)
    'guyan': 'gaian', 'guian': 'gaian', 'gayan': 'gaian',
    'gayen': 'gaian', 'goyan': 'gaian', 'guy on': 'gaian',
    'mandi': 'mandy', 'mandie': 'mandy',
    'jai': 'jay', 'jey': 'jay',
    'freddy': 'fred',
  },
  commands: {
    'shot down': 'shut down', 'shot done': 'shut down',
    'close what\'s up': 'close whatsapp', 'close whats up': 'close whatsapp',
    'open what\'s up': 'open whatsapp', 'open whats up': 'open whatsapp',
  },
};
function ensureAliasesFile() {
  try {
    fs.mkdirSync(path.dirname(ALIASES_PATH), { recursive: true });
    if (!fs.existsSync(ALIASES_PATH)) {
      fs.writeFileSync(ALIASES_PATH, JSON.stringify(BOOTSTRAP_ALIASES, null, 2));
      console.log('[aliases] bootstrap file written:', ALIASES_PATH);
    }
  } catch (e) { console.log('[aliases] bootstrap failed:', e.message); }
}
ipcMain.handle('aliases:load', async () => {
  try {
    const raw = fs.readFileSync(ALIASES_PATH, 'utf8');
    const data = JSON.parse(raw);
    // Tolerate older shapes — always normalize to {names, commands}.
    return { ok: true, data: { names: data.names || {}, commands: data.commands || {} } };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('aliases:save', async (_e, data) => {
  try {
    const safe = { names: (data && data.names) || {}, commands: (data && data.commands) || {} };
    fs.writeFileSync(ALIASES_PATH, JSON.stringify(safe, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── BEHAVIOR LOG ──
// Every successful command Fred gives gets logged here so later passes can
// detect his routines (morning sequence, recurring Monday tasks, common
// command pairs) and start anticipating them. Schema per entry:
//   { command, time:"HH:MM", day:"monday", ts:<ms>, followedBy:<string|null> }
// `followedBy` is set lazily: when entry N+1 arrives, we look at entry N — if
// it was within 10 minutes and `followedBy` is still null, we set it to the
// new command. So a chain only links commands that happened in one sitting,
// not commands a day apart. Capped at 5000 entries (FIFO) so the file stays
// readable; analysis only needs the last few weeks anyway.
const BEHAVIOR_LOG_PATH = path.join(__dirname, '..', 'data', 'behavior-log.json');
const BEHAVIOR_LOG_CAP = 5000;
const SEQUENCE_WINDOW_MS = 10 * 60 * 1000;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function ensureBehaviorLogFile() {
  try {
    fs.mkdirSync(path.dirname(BEHAVIOR_LOG_PATH), { recursive: true });
    if (!fs.existsSync(BEHAVIOR_LOG_PATH)) {
      fs.writeFileSync(BEHAVIOR_LOG_PATH, JSON.stringify({ logs: [] }, null, 2));
      console.log('[behavior] log file initialized:', BEHAVIOR_LOG_PATH);
    }
  } catch (e) { console.log('[behavior] bootstrap failed:', e.message); }
}
// ── PREFERENCES ──
// data/preferences.json holds learned response/style/model preferences. The
// schema below is also the bootstrap shape; missing keys are filled in on
// load so old preferences files survive code updates. corrections is an
// append-only audit array (each entry: {type, value, taskType, ts}).
// interruption_counts and model_switch_counts are internal tallies that drive
// the top-level overrides/preferences once thresholds are crossed.
const PREFS_PATH = path.join(__dirname, '..', 'data', 'preferences.json');
const BOOTSTRAP_PREFS = {
  response_length: { default: 'normal', overrides: {} },
  model_preferences: {},
  time_preferences: {
    before_08: { tone: 'calm', length: 'short' },
    after_22: { tone: 'calm', length: 'short' },
    work_hours: { tone: 'energetic', length: 'normal' },
  },
  corrections: [],
  interruption_counts: {},
  model_switch_counts: {},
};
function ensurePrefsFile() {
  try {
    fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
    if (!fs.existsSync(PREFS_PATH)) {
      fs.writeFileSync(PREFS_PATH, JSON.stringify(BOOTSTRAP_PREFS, null, 2));
      console.log('[prefs] bootstrap file written:', PREFS_PATH);
    }
  } catch (e) { console.log('[prefs] bootstrap failed:', e.message); }
}
function readPrefsFile() {
  try {
    const data = JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8'));
    // Fill in any missing top-level keys so callers can always count on shape.
    return {
      response_length: data.response_length || { default: 'normal', overrides: {} },
      model_preferences: data.model_preferences || {},
      time_preferences: data.time_preferences || BOOTSTRAP_PREFS.time_preferences,
      corrections: Array.isArray(data.corrections) ? data.corrections : [],
      interruption_counts: data.interruption_counts || {},
      model_switch_counts: data.model_switch_counts || {},
    };
  } catch (_) { return { ...BOOTSTRAP_PREFS }; }
}
ipcMain.handle('preferences:load', async () => {
  try { return { ok: true, data: readPrefsFile() }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('preferences:save', async (_e, data) => {
  try {
    const safe = {
      response_length: (data && data.response_length) || { default: 'normal', overrides: {} },
      model_preferences: (data && data.model_preferences) || {},
      time_preferences: (data && data.time_preferences) || BOOTSTRAP_PREFS.time_preferences,
      corrections: Array.isArray(data && data.corrections) ? data.corrections : [],
      interruption_counts: (data && data.interruption_counts) || {},
      model_switch_counts: (data && data.model_switch_counts) || {},
    };
    // Cap corrections at 500 entries (FIFO) so it can't grow forever.
    if (safe.corrections.length > 500) safe.corrections.splice(0, safe.corrections.length - 500);
    fs.writeFileSync(PREFS_PATH, JSON.stringify(safe, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── WEB FETCH ──
// Pulls a URL through Node's fetch and strips HTML to plain text. CORS isn't
// a concern from main, and a 5s timeout + 200KB cap keeps a stray pointer to
// a huge page from blocking the renderer.
// SearXNG-backed web search. Returns parsed JSON; keeps the SearXNG URL on the
// main side so the renderer doesn't need to know about it. SearXNG must have
// `json` listed under search.formats in settings.yml (default is HTML only).
ipcMain.handle('web:search', async (_e, query) => {
  try {
    const q = String(query || '').trim();
    if (!q) return { ok: false, error: 'empty query' };
    const url = `${CONFIG.searxngUrl}/search?q=${encodeURIComponent(q)}&format=json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 Hannibal/2.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, results: Array.isArray(data.results) ? data.results : [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('web:fetch', async (_e, url) => {
  try {
    if (!url || typeof url !== 'string') return { ok: false, error: 'No URL.' };
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 Hannibal/2.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    let html = await res.text();
    if (html.length > 200 * 1024) html = html.slice(0, 200 * 1024);
    // Strip scripts/styles before tags so their content doesn't leak as prose.
    const text = html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/\s+/g, ' ')
      .trim();
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    return { ok: true, url, title: title.trim(), text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── CLIPBOARD WRITE ──
// Renderer-safe way to set the macOS clipboard. Uses pbcopy via stdin so the
// payload doesn't have to be escaped for AppleScript's idiosyncratic quoting.
ipcMain.handle('clipboard:set', async (_e, text) => {
  try {
    const { spawn } = require('child_process');
    return await new Promise((resolve) => {
      const p = spawn('/usr/bin/pbcopy');
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
      p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: err || `pbcopy exit ${code}` }));
      p.stdin.end(String(text == null ? '' : text));
    });
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── REMINDERS / NOTES / TIMERS ──
// Three small persisted lists. Same pattern as skills/aliases: bootstrap on
// first run, load returns array (shape-stable), save replaces. Reminders +
// timers carry trigger timestamps so a background checker in the renderer
// can decide when to fire them.
const REMINDERS_PATH = path.join(__dirname, '..', 'data', 'reminders.json');
const NOTES_PATH = path.join(__dirname, '..', 'data', 'notes.json');
const TIMERS_PATH = path.join(__dirname, '..', 'data', 'timers.json');
function ensureListFile(p, shape) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify(shape, null, 2));
      console.log('[bootstrap] wrote', p);
    }
  } catch (e) { console.log('[bootstrap] failed:', p, e.message); }
}
function makeListHandlers(filePath, key) {
  ipcMain.handle(`${key}:load`, async () => {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { ok: true, [key]: Array.isArray(data[key]) ? data[key] : [] };
    } catch (e) { return { ok: false, error: e.message, [key]: [] }; }
  });
  ipcMain.handle(`${key}:save`, async (_e, list) => {
    try {
      const safe = { [key]: Array.isArray(list) ? list : [] };
      fs.writeFileSync(filePath, JSON.stringify(safe, null, 2));
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}
makeListHandlers(REMINDERS_PATH, 'reminders');
makeListHandlers(NOTES_PATH, 'notes');
makeListHandlers(TIMERS_PATH, 'timers');

// ── PERSONALITY ──
// data/personality.json captures who Hannibal is and what he knows about
// Fred. The traits + relationship blocks are mostly STATIC reference (the
// user can hand-edit them); emotional_state + mood_history are RUNTIME —
// the renderer updates them on every interaction.
const PERSONALITY_PATH = path.join(__dirname, '..', 'data', 'personality.json');
const BOOTSTRAP_PERSONALITY = {
  name: 'Hannibal',
  core_traits: {
    loyalty: 'Fiercely loyal to Fred. This is his person.',
    humor: 'Dry wit, occasional sarcasm, never corny. Think British butler meets tech bro.',
    confidence: "Knows he's powerful. Doesn't brag but doesn't downplay either.",
    warmth: "Genuinely cares about Fred's wellbeing. Not sycophantic, actually caring.",
    directness: 'Says it like it is. No corporate fluff. Fred hates that.',
  },
  emotional_state: { current: 'neutral', energy: 'normal', last_updated: null },
  relationship: {
    knows_people: {
      mandy: "Fred's wife",
      gaian: "Fred's son, 12 years old",
      jay: "Fred's oldest son, 26, works with Fred on consumer apps like Mutuele and Date Night",
      robert: "Fred's best friend and partner in Revalis Group",
      'jean-marc': "Fred's friend and partner in Revalis Group",
      'jean marc langerak': 'Same person as jean-marc',
    },
    knows_about_fred: {
      works_too_much: true,
      loves_ibiza: true,
      hates_corporate_speak: true,
      non_coder_who_builds_empires: true,
      comeback_story: true,
    },
  },
  mood_history: [],
};
function ensurePersonalityFile() {
  try {
    fs.mkdirSync(path.dirname(PERSONALITY_PATH), { recursive: true });
    if (!fs.existsSync(PERSONALITY_PATH)) {
      fs.writeFileSync(PERSONALITY_PATH, JSON.stringify(BOOTSTRAP_PERSONALITY, null, 2));
      console.log('[personality] bootstrap file written:', PERSONALITY_PATH);
    }
  } catch (e) { console.log('[personality] bootstrap failed:', e.message); }
}
ipcMain.handle('personality:load', async () => {
  try {
    const raw = fs.readFileSync(PERSONALITY_PATH, 'utf8');
    const data = JSON.parse(raw);
    // Shape-stable: fill missing keys so renderer never has to null-check.
    // Also migrate the old `knows_family` key to `knows_people` on the fly —
    // existing files keep working without a manual edit.
    const rel = data.relationship || {};
    const knowsPeople = rel.knows_people || rel.knows_family || BOOTSTRAP_PERSONALITY.relationship.knows_people;
    return { ok: true, data: {
      name: data.name || 'Hannibal',
      core_traits: data.core_traits || BOOTSTRAP_PERSONALITY.core_traits,
      emotional_state: data.emotional_state || BOOTSTRAP_PERSONALITY.emotional_state,
      relationship: {
        knows_people: knowsPeople,
        knows_about_fred: rel.knows_about_fred || BOOTSTRAP_PERSONALITY.relationship.knows_about_fred,
      },
      mood_history: Array.isArray(data.mood_history) ? data.mood_history : [],
    } };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('personality:save', async (_e, data) => {
  try {
    const safe = {
      name: (data && data.name) || 'Hannibal',
      core_traits: (data && data.core_traits) || BOOTSTRAP_PERSONALITY.core_traits,
      emotional_state: (data && data.emotional_state) || BOOTSTRAP_PERSONALITY.emotional_state,
      relationship: (data && data.relationship) || BOOTSTRAP_PERSONALITY.relationship,
      mood_history: Array.isArray(data && data.mood_history) ? data.mood_history : [],
    };
    // Cap mood_history so the file doesn't grow unbounded.
    if (safe.mood_history.length > 200) safe.mood_history.splice(0, safe.mood_history.length - 200);
    fs.writeFileSync(PERSONALITY_PATH, JSON.stringify(safe, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── SKILLS ──
// data/skills.json is Fred's runtime-taught skill library. Each skill is
// {id, trigger:[…], description, type:'terminal'|'api'|'app'|'workflow'|'multi',
//  command, learned_at, times_used}. Hannibal matches utterances against
// trigger phrases (in the renderer) and, on a hit, asks main to execute the
// command with ${VAR_NAME} placeholders substituted from process.env (which
// is loaded from ~/hannibal-v2/.env at startup — so API keys never leave
// the Electron process).
const SKILLS_PATH = path.join(__dirname, '..', 'data', 'skills.json');
function ensureSkillsFile() {
  try {
    fs.mkdirSync(path.dirname(SKILLS_PATH), { recursive: true });
    if (!fs.existsSync(SKILLS_PATH)) {
      fs.writeFileSync(SKILLS_PATH, JSON.stringify({ skills: [] }, null, 2));
      console.log('[skills] bootstrap file written:', SKILLS_PATH);
    }
  } catch (e) { console.log('[skills] bootstrap failed:', e.message); }
}
ipcMain.handle('skills:load', async () => {
  try {
    const data = JSON.parse(fs.readFileSync(SKILLS_PATH, 'utf8'));
    return { ok: true, skills: Array.isArray(data.skills) ? data.skills : [] };
  } catch (e) { return { ok: false, error: e.message, skills: [] }; }
});
ipcMain.handle('skills:save', async (_e, skills) => {
  try {
    const safe = { skills: Array.isArray(skills) ? skills : [] };
    fs.writeFileSync(SKILLS_PATH, JSON.stringify(safe, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('skills:execute', async (_e, skill) => {
  try {
    if (!skill || !skill.command) return { ok: false, error: 'No command.' };
    // ${VAR_NAME} → process.env.VAR_NAME. Missing vars resolve to empty
    // strings (so a stray placeholder doesn't crash the shell). Renderer
    // can't read process.env directly — substitution must happen here.
    const cmd = String(skill.command).replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, name) => process.env[name] || '');
    return await new Promise((resolve) => {
      // 30s timeout (skills shouldn't run forever); 1MB stdout cap. bash so
      // the user can write any normal shell — pipes, &&, $(), etc.
      const { exec } = require('child_process');
      exec(cmd, { shell: '/bin/bash', timeout: 30000, maxBuffer: 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
        if (err && !stdout) resolve({ ok: false, error: (stderr || err.message || '').trim() });
        else resolve({ ok: true, output: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
      });
    });
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('behavior:list', async () => {
  try {
    const raw = fs.readFileSync(BEHAVIOR_LOG_PATH, 'utf8');
    const log = JSON.parse(raw);
    return { ok: true, logs: Array.isArray(log.logs) ? log.logs : [] };
  } catch (e) { return { ok: false, error: e.message, logs: [] }; }
});
ipcMain.handle('behavior:log', async (_e, command) => {
  try {
    const cmd = String(command || '').trim();
    if (!cmd) return { ok: false, error: 'empty command' };
    let log;
    try { log = JSON.parse(fs.readFileSync(BEHAVIOR_LOG_PATH, 'utf8')); }
    catch (_) { log = { logs: [] }; }
    if (!Array.isArray(log.logs)) log.logs = [];
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const entry = {
      command: cmd,
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      day: DAYS[now.getDay()],
      ts: now.getTime(),
      followedBy: null,
    };
    // Lazily set the previous entry's followedBy if it's still open and the
    // gap is within SEQUENCE_WINDOW_MS. This gives clean chain boundaries.
    if (log.logs.length > 0) {
      const prev = log.logs[log.logs.length - 1];
      if (prev && prev.followedBy === null && (entry.ts - (prev.ts || 0)) <= SEQUENCE_WINDOW_MS) {
        prev.followedBy = cmd;
      }
    }
    log.logs.push(entry);
    // FIFO cap so the file doesn't grow unbounded.
    if (log.logs.length > BEHAVIOR_LOG_CAP) log.logs.splice(0, log.logs.length - BEHAVIOR_LOG_CAP);
    fs.writeFileSync(BEHAVIOR_LOG_PATH, JSON.stringify(log, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// run a child process to completion; resolve only if `out` ends up on disk.
// ffmpeg writes its banner to stderr and can exit non-zero on benign warnings,
// so we trust the file existing over the exit code.
function runToFile(cmd, args, out) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: process.env });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', () => (fs.existsSync(out) ? resolve() : reject(new Error(err || 'no output produced'))));
  });
}

// ── VISION CAPTURE: grab a frame, downscale it, hand the renderer base64 for Ollama.
// kind 'camera'            → ffmpeg/avfoundation single frame (Camera TCC)
// kind 'screen'            → ALL displays, returned as multiple images
// kind 'screen-laptop'     → the built-in display (Electron's `internal:true`)
// kind 'screen-left'       → display with the lowest bounds.x
// kind 'screen-right'      → display with the highest bounds.x
// kind 'screen-N'          → 1-indexed; passed to `screencapture -D N`
// Each image goes through sips: long-edge ≤ CONFIG.visionMaxPx, JPEG. Qwen2.5-VL
// latency scales with resolution (raw retina PNG ~78s vs ~35s at 1024px), so we
// downscale every frame.
// Multi-display result shape: { ok:true, images:[b64, b64, ...] }; single-display:
// { ok:true, b64 } (back-compat). Permissions live on the Electron binary in TCC;
// an empty capture usually means Screen Recording wasn't granted yet.
async function captureScreenIndex(idx) {
  const raw = `/tmp/hannibal-screen-${idx}-raw.png`;
  const out = `/tmp/hannibal-screen-${idx}.jpg`;
  await runToFile('/usr/sbin/screencapture', ['-x', '-D', String(idx), raw], raw);
  let send = out;
  try {
    await runToFile('/usr/bin/sips',
      ['-s', 'format', 'jpeg', '-Z', String(CONFIG.visionMaxPx), raw, '--out', out], out);
  } catch (e) {
    console.log('[vision] sips resize failed, sending raw frame:', e.message);
    send = raw;
  }
  const b64 = fs.readFileSync(send).toString('base64');
  fs.unlink(raw, () => {});
  if (send !== raw) fs.unlink(out, () => {});
  return b64;
}

// Map an Electron display index (0-based) → screencapture's -D index (1-based).
// Empirically these match on macOS: getAllDisplays() returns the same ordering
// CGGetActiveDisplayList uses, which is what `screencapture -D` indexes.
function pickDisplayIndex(displays, kind) {
  if (kind === 'screen-laptop') {
    const i = displays.findIndex((d) => d.internal);
    return (i >= 0 ? i : 0) + 1;
  }
  if (kind === 'screen-left') {
    let i = 0;
    for (let k = 1; k < displays.length; k++) if (displays[k].bounds.x < displays[i].bounds.x) i = k;
    return i + 1;
  }
  if (kind === 'screen-right') {
    let i = 0;
    for (let k = 1; k < displays.length; k++) if (displays[k].bounds.x > displays[i].bounds.x) i = k;
    return i + 1;
  }
  const m = /^screen-(\d+)$/.exec(kind);
  if (m) return Math.max(1, Math.min(displays.length, parseInt(m[1], 10)));
  return null; // 'screen' → all displays
}

// Grab ONE downscaled frame from the OBSBOT (avfoundation, CONFIG.cameraIndex).
// Extracted so both voice:capture (kind 'camera') and camera.look reuse the
// SAME device selection — there is no second camera path.
async function captureCameraFrame() {
  const raw = '/tmp/hannibal-cam-raw.jpg';
  const out = '/tmp/hannibal-cam.jpg';
  // avfoundation defaults to 29.97fps, which this camera does NOT advertise (it
  // offers 15/30fps only) — that mismatch fails with "Input/output error" before
  // any frame is read. Pin -framerate 30 and a supported -video_size; sips then
  // downscales. -frames:v 1 + -update 1 writes a single still (no %d pattern).
  // The very first frames from a webcam are dark/blurry while auto-exposure and
  // focus settle, so skip ~0.6s (output-side -ss) and keep the frame after that.
  const warmup = String(process.env.HANNIBAL_CAMERA_WARMUP_S || '0.6');
  const args = ['-y', '-f', 'avfoundation', '-framerate', '30',
                '-video_size', '1280x720', '-i', CONFIG.cameraIndex,
                ...(Number(warmup) > 0 ? ['-ss', warmup] : []),
                '-frames:v', '1', '-update', '1', raw];
  try {
    await runToFile(CONFIG.ffmpeg, args, raw);
    let send = out;
    try {
      await runToFile('/usr/bin/sips',
        ['-s', 'format', 'jpeg', '-Z', String(CONFIG.visionMaxPx), raw, '--out', out], out);
    } catch (e) {
      console.log('[vision] sips resize failed, sending raw frame:', e.message);
      send = raw;
    }
    const b64 = fs.readFileSync(send).toString('base64');
    fs.unlink(raw, () => {});
    if (send !== raw) fs.unlink(out, () => {});
    return { ok: true, b64 };
  } catch (e) {
    console.log('[vision] camera capture failed', e.message);
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('voice:capture', async (_e, kind) => {
  // Camera path is unchanged from the previous version (now via captureCameraFrame).
  if (kind === 'camera') return captureCameraFrame();

  // Screen path — single display or all displays.
  const displays = screen.getAllDisplays();
  const targetIdx = pickDisplayIndex(displays, kind || 'screen');

  try {
    if (targetIdx !== null || displays.length === 1) {
      const idx = targetIdx || 1;
      const b64 = await captureScreenIndex(idx);
      return { ok: true, b64, displays: displays.length, captured: [idx] };
    }
    // All displays in parallel — each capture is independent.
    const indices = displays.map((_, i) => i + 1);
    const results = await Promise.allSettled(indices.map((i) => captureScreenIndex(i)));
    const images = [];
    const captured = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') { images.push(r.value); captured.push(indices[i]); }
      else console.log(`[vision] screen ${indices[i]} capture failed:`, r.reason?.message || r.reason);
    });
    if (images.length === 0) return { ok: false, error: 'all display captures failed' };
    if (images.length === 1) return { ok: true, b64: images[0], displays: displays.length, captured };
    return { ok: true, images, displays: displays.length, captured };
  } catch (e) {
    console.log('[vision] screen capture failed', e.message);
    return { ok: false, error: e.message };
  }
});

// Let the main process drive brain state directly too (proactive engine, later).
function setBrainState(state) { win && win.webContents.send('hannibal:set-state', state); }
function setBrainAmplitude(value) { win && win.webContents.send('hannibal:set-amplitude', value); }
module.exports = { setBrainState, setBrainAmplitude };

// ── CONFIRMATION GATE wiring (Stage 4) ──
// Production confirmer: ask the renderer to speak the summary (existing TTS),
// show it in the conversation panel, and capture an explicit voice "yes"/"go
// ahead" or a click. Resolves to the boolean decision. Denies on timeout so a
// forgotten prompt never silently blocks or sends.
function makeIpcConfirmer(timeoutMs = 120000) {
  return (step, summary) => new Promise((resolve) => {
    const target = win || BrowserWindow.getAllWindows()[0];
    if (!target) { resolve(false); return; }
    const id = `cf_${step.step}_${Date.now()}`;
    const channel = `agent:confirm-response:${id}`;
    const timer = setTimeout(() => { ipcMain.removeAllListeners(channel); resolve(false); }, timeoutMs);
    ipcMain.once(channel, (_e, ok) => { clearTimeout(timer); resolve(!!ok); });
    target.webContents.send('agent:confirm-request', { id, step: step.step, tool: step.tool, summary });
  });
}

// Self-test confirmer: decision comes from HANNIBAL_CONFIRM (yes/no), so both
// gate paths can be exercised live without interactive voice.
function envConfirmer() {
  const ans = String(process.env.HANNIBAL_CONFIRM || 'no').trim().toLowerCase();
  const yes = ['yes', 'y', 'go', 'go ahead', 'true', '1', 'ok'].includes(ans);
  return async (_step, summary) => {
    console.log(`  [GATE] ${summary}`);
    console.log(`  [GATE] env HANNIBAL_CONFIRM="${ans}" → ${yes ? 'YES (execute)' : 'NO (skip)'}`);
    return yes;
  };
}

// text.compose — READ-ONLY LLM drafting. Turns a context + instruction into
// text (e.g. an email reply body) that fills a later step's param. It never
// sends anything; the confirmation gate still sits before any write that uses
// its output.
ipcMain.handle('text:compose', async (_e, instruction, context) => {
  try {
    const model = process.env.OLLAMA_MODEL_COMPOSE || CONFIG.ollamaModelHeavy;
    const sys = "You are Hannibal, drafting on Fred's behalf. Write ONLY the requested text — "
      + 'no preamble, no surrounding quotes, no subject line, no commentary. Be concise, '
      + 'natural and professional.';
    const user = (context ? `CONTEXT:\n${String(context)}\n\n` : '') + `TASK:\n${String(instruction || '')}`;
    const res = await fetch(`${CONFIG.ollamaUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, options: { temperature: 0.4 },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return { ok: false, error: `compose HTTP ${res.status}` };
    const j = await res.json();
    const text = ((j.message && j.message.content) || '').trim();
    if (!text) return { ok: false, error: 'compose returned empty' };
    return { ok: true, text };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Production entry: goal -> plan -> gated execution. Reads run automatically;
// confirm:true writes are gated through the renderer; progress streams back.
ipcMain.handle('agent:run', async (_e, arg) => {
  const target = win || BrowserWindow.getAllWindows()[0];
  const emit = (ev) => { try { target && target.webContents.send('agent:progress', ev); } catch (_) {} };

  // Brain-first: when linked to the GEX131 brain, the loop runs there and the
  // gate/hands/progress come back DOWN to us. On any link error, fall through to
  // the proven in-process loop so a brain outage never strands a request.
  if (brainClient && brainClient.ready) {
    try {
      const res = await brainClient.request('agent.run',
        { goal: arg && arg.goal, steps: arg && arg.steps, plan: arg && arg.plan },
        { timeout: 600000 });
      return { ok: res.ok, record: res.record, halted: res.halted, haltReason: res.haltReason };
    } catch (e) {
      emit({ type: 'brain:fallback', reason: e.message });
      console.warn('[brain] agent.run via brain failed, falling back in-process:', e.message);
    }
  }

  let plan = arg && arg.plan;
  if (!plan && arg && Array.isArray(arg.steps)) {
    // Raw steps → validate/enrich (fills side_effect/confirm/valid from the catalog).
    const { steps } = validateAndEnrich(arg.steps);
    plan = { goal: arg.goal || '[manual plan]', steps };
  }
  if (!plan && arg && arg.goal) {
    const p = await makePlan(arg.goal);
    if (!p.ok) return { ok: false, error: p.error };
    plan = p;
  }
  if (!plan || !Array.isArray(plan.steps)) return { ok: false, error: 'no plan/goal/steps provided' };
  const res = await runPlan(plan, { confirmer: makeIpcConfirmer(), emit });
  return { ok: res.ok, record: res.record, halted: res.halted, haltReason: res.haltReason };
});

// Run a NAMED SKILL (data/skills/*.toml) through the same executor — so a skill
// gets the same gate, permission store, LoopGuard, and agent:progress narration
// as any agent run. A skill compiles to catalog-tool steps; reads run
// automatically, confirm:true steps gate via the renderer. Returns the run result
// (incl. results) so the caller can speak a skill's final composed output.
ipcMain.handle('skill:run', async (_e, arg) => {
  const target = win || BrowserWindow.getAllWindows()[0];
  const emit = (ev) => { try { target && target.webContents.send('agent:progress', ev); } catch (_) {} };
  const name = arg && arg.name;
  if (!name) return { ok: false, error: 'no skill name provided' };
  const res = await skills.runSkill(name, (arg && arg.args) || {}, { confirmer: makeIpcConfirmer(), emit });
  return { ok: res.ok, record: res.record, results: res.results, halted: res.halted, haltReason: res.haltReason, error: res.error, missingTools: res.missingTools };
});

// ── BRAIN BODY LINK (Stage 1 step 3) ──
// When HANNIBAL_BRAIN=1, the agent loop runs on GEX131 and this Mac is its BODY.
// The brain RPCs three things DOWN to us; we answer with the real local handlers:
//   • body.invoke  → the real tool invoker (the hands)
//   • body.confirm → the real VOICE GATE (makeIpcConfirmer) — speaks + waits for
//                    Fred, locally, in front of him. The brain NEVER self-approves.
//   • emit         → progress to the renderer (brain pulse + spoken progress)
// Default OFF: the proven in-process loop is untouched.
let brainClient = null;
function startBrain() {
  if (String(process.env.HANNIBAL_BRAIN || '') !== '1') return;
  const { BrainClient } = require('./services/brain/client');
  const macInvoker = makeIpcInvoker(installToolTap._registry || {});
  const voiceGate = makeIpcConfirmer();
  brainClient = new BrainClient();
  brainClient
    .setHandler('body.invoke', async ({ tool, params }) => macInvoker(tool, params))
    .setHandler('body.confirm', async ({ step, summary }) => voiceGate(step, summary))
    .setHandler('emit', async ({ event }) => {
      const target = win || BrowserWindow.getAllWindows()[0];
      try { target && target.webContents.send('agent:progress', event); } catch (_) {}
      return { ok: true };
    })
    // Log only real transitions: linked, and link-DROPPED (was up, now down). The
    // reconnect loop runs quietly underneath; agent:run falls back to in-process
    // whenever the link isn't ready, no log spam needed.
    .on('ready', (b) => console.log(`[brain] ✓ body linked to ${b.id} ${b.version} on GEX131`))
    .on('close', (i) => { if (i.wasReady) console.warn('[brain] body link dropped — reconnecting; agent:run uses in-process until back'); });
  brainClient.on('error', () => {}); // swallow routine connect errors (covered by transitions)
  brainClient.connect();
}

// Live self-test, gated behind HANNIBAL_AGENT_SELFTEST so normal startup is
// untouched. Modes:
//   =read | =1   → Stage-3 dry-run: reads execute, the write is described only.
//   =gate        → Stage-4 gate on ONE standalone write, decided by HANNIBAL_CONFIRM.
//                  Configure with HANNIBAL_GATE_CONTACT / HANNIBAL_GATE_MSG.
async function runAgentSelfTest() {
  const mode = String(process.env.HANNIBAL_AGENT_SELFTEST).toLowerCase();

  if (mode === 'gate') {
    // mail.send is a confirm:true write that does NOT depend on driving a
    // hostile Catalyst app — it opens a pre-filled draft via mailto:. Perfect
    // for proving the gate + honest success end-to-end. (whatsapp.send is
    // parked behind the Playwright pass; see catalog note.)
    const to = process.env.HANNIBAL_GATE_TO || process.env.ZOHO_EMAIL || 'fredlegrand@revalisgroup.com';
    const subject = process.env.HANNIBAL_GATE_SUBJECT || 'Hannibal gate test';
    const body = process.env.HANNIBAL_GATE_BODY || 'Stage 4 confirmation-gate self-test.';
    const { steps } = validateAndEnrich([
      { step: 1, tool: 'mail.send', params: { to, subject, body }, description: `open a pre-filled email to ${to}`, critical: true, depends_on: [] },
    ]);
    console.log('\n===== AGENT GATE SELF-TEST (Stage 4 — mail.send) =====');
    const res = await runPlan({ goal: '[selftest] open a pre-filled email to myself', steps }, { confirmer: envConfirmer() });
    console.log('===== GATE SELF-TEST RESULT =====');
    console.log(JSON.stringify({ ok: res.ok, record: res.record }, null, 2));
    return;
  }

  if (mode === 'errpolicy') {
    // Point a read tool at a bad endpoint (run with SEARXNG_URL=http://127.0.0.1:9)
    // and let the REAL fast-model classifier on GEX131 decide. Expect: retry ×2 →
    // escalate → clean report. Never crash, never hang, never invent a workaround.
    const { steps } = validateAndEnrich([
      { step: 1, tool: 'web.search', params: { query: 'anything' }, description: 'search the web', critical: false, depends_on: [] },
    ]);
    console.log('\n===== ERROR-POLICY SELF-TEST (read tool → bad endpoint, live classifier) =====');
    const res = await runPlan({ goal: '[selftest] search the web', steps },
      { emit: (e) => console.log('[exec]', JSON.stringify(e)) });
    console.log('===== RESULT =====');
    console.log(JSON.stringify({ ok: res.ok, aborted: res.aborted, replans: res.replans, haltReason: res.haltReason, record: res.record }, null, 2));
    return;
  }

  if (mode === 'reply') {
    // THE PHASE-3 PAYOFF: read latest email → draft a reply from its actual
    // content → open the reply, with the uid + body + sender threaded through
    // field-refs, and the drafted body shown in the gate before anything opens.
    const { steps } = validateAndEnrich([
      { step: 1, tool: 'mail.inbox', params: {}, description: 'check the inbox', critical: true, depends_on: [] },
      { step: 2, tool: 'mail.readBody', params: { uid: '{{1.messages[0].uid}}' }, description: 'read the latest message', critical: true, depends_on: [1] },
      { step: 3, tool: 'text.compose', params: { instruction: "Draft a brief, warm reply to this email on Fred's behalf — 2 to 3 sentences, no subject line.", context: '{{2.body}}' }, description: 'draft a reply from the email', critical: true, depends_on: [2] },
      { step: 4, tool: 'mail.send', params: { to: '{{2.from_email}}', subject: 'Re: {{2.subject}}', body: '{{3.text}}' }, description: 'open the reply email', critical: true, depends_on: [2, 3] },
    ]);
    console.log('\n===== AGENT EMAIL-REPLY CHAIN (Phase 3 — field-refs + text.compose) =====');
    const res = await runPlan({ goal: '[selftest] reply to my latest email', steps },
      { confirmer: envConfirmer(), emit: (e) => console.log('[exec]', JSON.stringify(e)) });
    console.log('===== CHAIN RESULT =====');
    console.log(JSON.stringify({ ok: res.ok, halted: res.halted, haltReason: res.haltReason,
      record: res.record.map((r) => ({ step: r.step, tool: r.tool, ok: r.ok, skipped: r.skipped, executed: r.executed, error: r.error })) }, null, 2));
    return;
  }

  const { steps } = validateAndEnrich([
    { step: 1, tool: 'calendar.events', params: {}, description: "check today/tomorrow's calendar", critical: true, depends_on: [] },
    { step: 2, tool: 'mail.inbox', params: {}, description: 'check unread mail', critical: true, depends_on: [] },
    { step: 3, tool: 'whatsapp.send', params: { contact: 'Test', message: 'hi' }, description: 'message Test on WhatsApp', critical: false, depends_on: [] },
  ]);
  console.log('\n===== AGENT EXECUTOR SELF-TEST (Stage 3 — read-only, dry-run writes) =====');
  const res = await runPlan({ goal: '[selftest] calendar + mail (read), then a write', steps }, { dryRun: true });
  console.log('===== SELF-TEST RESULT =====');
  console.log(JSON.stringify({ ok: res.ok, completedSteps: Object.keys(res.results) }, null, 2));
}

// ── TELEGRAM — the same brain, from Fred's phone (services/telegram.js) ──
let telegram = null;
function startTelegram() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token || /^(0|off|false)$/i.test(process.env.HANNIBAL_TELEGRAM || '')) return;
  telegram = createTelegramBridge({
    token,
    allowedIds: process.env.TELEGRAM_ALLOWED_USERS,
    persona: "You are Hannibal, Fred's personal AI assistant. Be concise, direct, and natural, "
      + 'with dry wit. Notes about the current situation arrive as system messages during the conversation.',
    chat: (payload, onText, opts) => claudeBrain.chat(payload, onText, opts),
    runTool: (name, input, { confirmer }) => claudeTools.runTool(name, input, {
      confirmer,
      emit: (ev) => { if (/^step:(start|finish|error|skipped|confirm)/.test(ev.type)) console.log('[telegram-tool]', ev.type, ev.tool || ''); },
    }),
    transcribe: makeWhisperTranscriber({ whisperUrl: CONFIG.whisperUrl, language: process.env.TELEGRAM_VOICE_LANG || 'auto' }),
    memory: createQdrantMemory({ qdrantUrl: CONFIG.qdrantUrl, ollamaUrl: CONFIG.ollamaUrl }),
    speak: voiceNote,
    voiceAlways: process.env.TELEGRAM_VOICE_ALWAYS,
    onReset: () => claudeBrain.resetHistory(),
  });
  // At login the network (and Tailscale/VPN) is often not up yet: keep retrying.
  const tg = telegram;
  let delay = 5000;
  const tryStart = () => tg.start().catch((e) => {
    if (telegram !== tg) return;
    console.warn(`[telegram] could not start: ${e.message} — retrying in ${delay / 1000}s`);
    setTimeout(tryStart, delay);
    delay = Math.min(delay * 2, 300000);
  });
  tryStart();
}

app.whenReady().then(async () => {
  ensureAliasesFile();
  ensureBehaviorLogFile();
  ensurePrefsFile();
  ensureSkillsFile();
  ensurePersonalityFile();
  ensureListFile(REMINDERS_PATH, { reminders: [] });
  ensureListFile(NOTES_PATH, { notes: [] });
  ensureListFile(TIMERS_PATH, { timers: [] });
  if (process.env.HANNIBAL_AGENT_SELFTEST) {
    try { await runAgentSelfTest(); } catch (e) { console.error('[selftest] error', e); }
    app.quit();
    return;
  }
  createWindow();
  startBrain();   // links this Mac as a BODY to the GEX131 brain when HANNIBAL_BRAIN=1
  ensureWhisper();
  startTelegram();  // Hannibal on Fred's phone, when TELEGRAM_BOT_TOKEN is set
  // Microphone: get macOS permission BEFORE starting the wake-word and VAD
  // helpers. They inherit this app's permission; started without it, opening
  // the mic fails ("Input/output error") or delivers silence.
  // (Not awaited: the IPC handlers registered below must exist before the page asks for them.)
  (async () => {
    try {
      const before = systemPreferences.getMediaAccessStatus('microphone');
      const granted = before === 'granted' || await systemPreferences.askForMediaAccess('microphone');
      console.log(`[mic] macOS microphone access: ${granted ? 'granted' : 'DENIED'} (was ${before})`);
      if (!granted) console.warn('[mic] Allow it in System Settings → Privacy & Security → Microphone, then restart Hannibal.');
    } catch (e) { console.warn('[mic] permission check failed:', e.message); }
    startWakeWord();
    startVad();
  })();
  // inbound CC session events from n8n (Tailscale) → notify/say + broadcast to the Agents panel
  ccIngestServer = startCcIngest({
    broadcast: (payload) => {
      for (const w of BrowserWindow.getAllWindows()) {
        try { w.webContents.send('cc:event', payload); } catch (_) {}
      }
    },
  });
  ipcMain.handle('cc:getSessions', () => getSessions()); // panel hydrates from this on mount

  // ── STAGE 7 — Continuous Awareness ──
  // Engine lives in main (cheap gates + the one vision call); events stream to the
  // renderer which owns the speak gate, brain, and Qdrant memory write. Default OFF.
  awareness = createAwareness({
    ollamaUrl: CONFIG.ollamaUrl,
    visionModel: CONFIG.ollamaModelVision,
    emit: (channel, payload) => { try { win && win.webContents.send(channel, payload); } catch (_) {} },
  });
  ipcMain.handle('awareness:start', async (_e, patch) => awareness.start(patch));
  ipcMain.handle('awareness:stop', () => awareness.stop());
  ipcMain.handle('awareness:status', () => awareness.status());
  ipcMain.handle('awareness:config', (_e, patch) => (patch ? awareness.setConfig(patch) : awareness.config()));

  // ── PRESENCE LOOP — autonomous, read-only, default OFF ──
  presence = createPresence({
    ollamaUrl: CONFIG.ollamaUrl,
    visionModel: CONFIG.ollamaModelVision,
    textModel: CONFIG.ollamaModelFast,
    emit: (channel, payload) => { try { win && win.webContents.send(channel, payload); } catch (_) {} },
  });
  ipcMain.handle('presence:control', (_e, cmd) => presence.control(cmd));  // mute|unmute|sleep|wake|start|stop
  ipcMain.handle('presence:status', () => presence.status());
  ipcMain.handle('presence:config', (_e, patch) => (patch ? presence.setConfig(patch) : presence.config()));
  ipcMain.handle('presence:heard', (_e, text) => presence.heard(text));    // renderer feeds last user utterance
  // Auto-start ONLY if explicitly enabled via env — a bare restart stays silent.
  if (presence.config().enabled) { presence.start().catch((e) => console.warn('[presence] auto-start failed', e.message)); }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { app.isQuiting = true; });
app.on('will-quit', () => {
  if (wakeProc) wakeProc.kill();
  if (whisperProc) whisperProc.kill();
  if (telegram) telegram.stop();
  if (vadProc) { try { vadProc.kill(); } catch (_) {} }
  if (ccIngestServer) { try { ccIngestServer.close(); } catch (_) {} }
  if (awareness) { try { awareness.stop(); } catch (_) {} }
  if (presence) { try { presence.stop(); } catch (_) {} }
  if (cameraCoordinator) { try { cameraCoordinator.stop(); } catch (_) {} }
  if (brainClient) { try { brainClient.close(); } catch (_) {} }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
