const { app, BrowserWindow, ipcMain, screen, systemPreferences, powerMonitor } = require('electron');
// His voice may start without a click (a reminder, the morning brief, after sleep).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
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
const { registerCameraControl, CFG: cameraCfg, _internal: cameraOsc } = require('./services/camera-control');
// Chat brain: Claude API via the official SDK (streamed, prompt-cached). The
// renderer falls back to Ollama on GEX131 whenever this returns ok:false.
const claudeBrain = require('./services/claude-brain');
const claudeTools = require('./services/claude-tools');
const { registerFacts } = require('./services/memory-facts');
const { registerProactive } = require('./services/proactive');
const { createTelegramBridge, makeWhisperTranscriber } = require('./services/telegram');
const { createQdrantMemory, registerMemoryIpc } = require('./services/qdrant-memory');
const { registerInfo } = require('./services/info-handlers');
const { createVoiceIO } = require('./services/voice-io');   // his voice + ears on Apple's echo cancelling
const { createCameraPicker } = require('./services/camera-device');
const { createFaceFollow, greetingFor } = require('./services/face-follow');
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

// ── SELF-UPDATE: pull merged PRs, deploy the server, restart when Fred is away ──
function startSelfUpdate() {
  try {
    const { createSelfUpdate } = require('./services/self-update');
    const dir = path.join(__dirname, '..');
    const updater = createSelfUpdate({
      dir,
      statePath: path.join(require('os').homedir(), 'Library', 'Application Support', 'Hannibal', 'self-update.json'),
      idleSeconds: () => { try { return powerMonitor.getSystemIdleTime(); } catch (_) { return 0; } },
      lastSpokeAt: () => lastSpokeAt,
      // Fred hears it on his phone (through the server, else Telegram from here).
      notify: async (text) => {
        if (linked()) { await bodyLink.request('phone.notify', { text, voice: false }); return; }
        if (telegram) await telegram.notify(text);
      },
      // Quit and reopen through the Login Item app, same as a manual restart.
      restart: () => {
        const sh = `sleep 2; cd ${JSON.stringify(dir)} && ./start.sh --stop >/dev/null 2>&1; sleep 2; open ~/Applications/Hannibal.app 2>/dev/null || ./start.sh`;
        spawn('/bin/sh', ['-c', sh], { detached: true, stdio: 'ignore' }).unref();
      },
    });
    updater.start();
  } catch (e) { console.warn('[update] not started:', e.message); }
}

// Link to the always-on server (server/hannibal-server.js), when it runs Telegram.
let bodyLink = null;
const linked = () => !!(bodyLink && bodyLink.ready);

const proactive = registerProactive(ipcMain, {
  getWindow: () => win,
  // Briefs and reminders also reach Fred's phone, wherever he is. With the
  // always-on server, it sends its own morning brief; desk reminders go via it.
  onBrief: (text) => { if (telegram) telegram.notify(`☀️ Morning brief\n\n${text}`, { voice: true }).catch(() => {}); },
  onNudgeDone: (r) => { const done = pendingNudges.get(r.id); if (done) { pendingNudges.delete(r.id); done(r.ok); } },
  // Returns a promise so the reminder is marked delivered (or not) for reminders.recent.
  onReminder: (message) => {
    const text = `⏰ Reminder: ${message}`;
    if (telegram) return telegram.notify(text).then(() => true);
    if (linked()) return bodyLink.request('phone.notify', { text, voice: true }).then(() => true);
    return undefined;   // no phone reachable: the banner and his voice still carry it
  },
  banner: (title, body) => { const { Notification } = require('electron'); if (Notification.isSupported()) new Notification({ title, body }).show(); },
});   // morning brief + reminders.add/cancel/upcoming

// Saved facts: while linked, the server's copy is the master. A change made at
// the desk is applied here at once and sent up; the server's list comes back.
const { getDefaultFactStore } = require('./services/memory-facts');
const deskFacts = getDefaultFactStore();
// The list desk and server last agreed on, so a reconnect can tell what was
// added or deleted on either side in the meantime (and not undo a deletion).
const SYNCED_FACTS = path.join(path.dirname(deskFacts.file), 'memory-facts.synced.json');
function lastSyncedFacts() {
  try { const j = JSON.parse(fs.readFileSync(SYNCED_FACTS, 'utf8')); return Array.isArray(j.facts) ? j.facts : null; }
  catch (_) { return null; }
}
function applyServerFacts(list) {
  if (!Array.isArray(list)) return;
  const r = deskFacts.replaceAll(list);
  if (r && r.ok) {
    try { fs.writeFileSync(SYNCED_FACTS, JSON.stringify({ facts: list.map((f) => ({ id: f.id, text: f.text })) })); } catch (_) {}
    console.log(`[body] facts in sync with the server (${r.total})`);
  }
}
function factsUp(method, params) {
  if (!linked()) return;
  bodyLink.request(method, params).then((r) => applyServerFacts(r && r.facts)).catch((e) => console.warn(`[body] ${method} failed:`, e.message));
}
registerFacts(ipcMain, {
  remember: (text, category) => { const r = deskFacts.remember(text, category); if (r.ok) factsUp('facts.remember', { text, category }); return r; },
  forget: (query) => { const r = deskFacts.forget(query); if (r.ok) factsUp('facts.forget', { query }); return r; },
  list: (category) => deskFacts.list(category),
});
// One Qdrant memory for the desk (memory:store / memory:search) and Telegram,
// so the same keep-or-skip, dedupe and recall rules apply everywhere.
let _memory = null;
function sharedMemory() {
  if (!_memory) _memory = createQdrantMemory({ qdrantUrl: CONFIG.qdrantUrl, ollamaUrl: CONFIG.ollamaUrl });
  return _memory;
}
// Conversation diary: every exchange is noted; quiet spells become summarized
// episodes in Claude's prompt. The server's diary is the master: new episodes
// go up, and the server's come down (conversation-journal.js).
const { createJournal, registerJournal } = require('./services/conversation-journal');
const deskJournal = createJournal({
  filePath: path.join(path.dirname(deskFacts.file), 'conversations.json'),
  embed: (t) => sharedMemory().embed(t),   // find conversations by meaning
  summarize: (t, p) => claudeBrain.summarizeForJournal(t, p),
  onEpisode: (ep) => {
    if (!linked()) return;
    bodyLink.request('journal.add', { episodes: [ep] })
      .then((r) => deskJournal.merge(r && r.episodes)).catch((e) => console.warn('[body] journal.add failed:', e.message));
  },
});
registerJournal(ipcMain, deskJournal);
// Threads: each thing Fred and Hannibal are working on, with its current status
// (threads.js). Changes go up to the server, and the server's come down.
const { createThreadStore, registerThreads } = require('./services/threads');
let threadsUpTimer = null;
const deskThreads = createThreadStore({
  filePath: path.join(path.dirname(deskFacts.file), 'threads.json'),
  embed: (t) => sharedMemory().embed(t),
  onChange: () => {
    if (threadsUpTimer) clearTimeout(threadsUpTimer);
    threadsUpTimer = setTimeout(() => {
      if (!linked()) return;
      bodyLink.request('threads.sync', { threads: deskThreads.all() })
        .then((r) => deskThreads.merge(r && r.threads)).catch((e) => console.warn('[body] threads.sync failed:', e.message));
    }, 3000);
  },
});
registerThreads(ipcMain, deskThreads);
claudeBrain.setThreads(deskThreads);
claudeBrain.setJournal(deskJournal, { liveFile: path.join(path.dirname(deskFacts.file), 'conversation-live.json'), whereName: 'desk' });
registerMemoryIpc(ipcMain, { store: (t, m) => sharedMemory().store(t, m), search: (t, l) => sharedMemory().search(t, l) });
// Claude's memory.query tool uses the same picky search.
require('./services/agent/executor').setShim('memory.query', async ({ text, limit = 3 } = {}) =>
  ({ ok: true, results: await sharedMemory().search(String(text || ''), Math.min(Number(limit) || 3, 10)) }));   // 'facts:remember' / 'facts:forget' / 'facts:list' — saved facts Claude always knows
// 'llm:chat' → tokens stream back on 'llm:token'. Claude can also use Hannibal's
// actions: each tool call runs through the SAME executor + voice confirmation gate
// as the agent loop (claude-tools.js). Turn off with HANNIBAL_CLAUDE_TOOLS=0.
claudeBrain.registerClaudeBrain(ipcMain, {
  runTool: (name, input) => claudeTools.runTool(name, input, {
    desk: true,   // Fred is at the Mac: Hannibal's hands (computer.*) may be used
    confirmer: makeIpcConfirmer(),
    // Log only: the renderer's agent:progress narration belongs to agent:run plans,
    // and Claude narrates its own work.
    emit: (ev) => { if (/^step:(start|finish|error|skipped|confirm)/.test(ev.type)) console.log('[claude-tool]', ev.type, ev.tool || ''); },
  }),
  onToolEvent: (ev) => { try { win && win.webContents.send('llm:tool', ev); } catch (_) {} },
  // Each request from Fred is a new task for the hands: fresh step budget, stop cleared.
  onTurn: (phase) => { if (phase === 'start') computer.newTask(); else computer.endTask(); },
});
registerControls(ipcMain); // 'browser-action' + 'mac-control' IPC handlers
// ── HANDS: keyboard + mouse on any app (services/computer/). Every call goes
// through computer.preflight (risky targets → the voice yes/no gate) and is
// stopped at once by "Hannibal stop", Esc×3 or the wake word while driving.
// Needs Accessibility for Electron: System Settings → Privacy & Security → Accessibility.
const { createComputer, createIndicator } = require('./services/computer/computer-control');
const { createHands } = require('./services/computer/hands');
const computerHands = createHands({ onEvent: (ev) => { if (ev && ev.ev === 'esc') computer.onEsc(); } });
const computer = createComputer({
  hands: computerHands,
  electron: { screen, nativeImage: require('electron').nativeImage, clipboard: require('electron').clipboard },
  indicator: createIndicator({ BrowserWindow, screen }),
  onAbort: (why) => {
    console.warn('[computer] STOP:', why);
    claudeBrain.interrupt();
    try { win && win.webContents.send('computer:stopped', { why }); } catch (_) {}
  },
  onDriving: (on) => { try { win && win.webContents.send('computer:driving', { on }); } catch (_) {} },
});
computer.register(ipcMain);   // 'computer' (actions), 'computer:stop', 'computer:status'
claudeTools.setPreflight((name, params) => computer.preflight(String(name).replace(/^computer\./, ''), params));
// Calendar: past times, clashes, which calendar/event, reminders, repeats are
// sorted out before Fred is asked (services/calendar-assist.js). Set below,
// once the calendar handlers are registered.
registerWorld(ipcMain);    // 'world:crypto' (after registerControls so EYES can reuse 'browser-action' open)
// The coordinator (single owner of the gimbal) is returned so we can stop its
// follow-watchdog on quit. See camera-coordinator.js.
// Hannibal turns the OBSBOT himself to keep Fred in frame (services/face-follow.js).
const faceFollow = createFaceFollow({
  oscMessage: cameraOsc.oscMessage, port: cameraCfg.port, host: cameraCfg.host,
  // Fred walked in after 10+ min away (HANNIBAL_GREET_AWAY_MIN): say hello. Goes
  // through the same speak gate as camera remarks (mute/sleep/in-conversation).
  onArrive: ({ awayMs }) => {
    if (process.env.HANNIBAL_GREET === '0') return;
    // Respect a mute/sleep Fred set earlier (saved by presence, even while its loop is off).
    try { const st = presence && presence.status(); if (st && (st.muted || st.sleeping)) { console.log('[follow] greeting withheld (presence muted/asleep)'); return; } } catch (_) {}
    const text = greetingFor({ awayMs });
    try { win && win.webContents.send('presence:remark', { text, interest: 1, referent: 'Fred arriving', ts: Date.now() }); } catch (_) {}
  },
});
const cameraCoordinator = registerCameraControl(ipcMain, { captureCameraFrame: (...a) => captureCameraFrame(...a), follow: faceFollow }); // 'camera:control'

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
  whisperScript: process.env.WHISPER_SCRIPT || path.join(__dirname, 'services', 'stt-server.js'), // Hannibal's own fast ears (whisper.cpp kept loaded on the GPU)
  whisperUrl: process.env.WHISPER_URL || 'http://127.0.0.1:8765',
  ollamaUrl:  process.env.OLLAMA_URL  || 'http://127.0.0.1:11434',
  // Multi-model router: most turns ("how are you") go to a small, instant model;
  // only complex requests escalate to the heavy 70b. Both env-overridable.
  ollamaModel:     process.env.OLLAMA_MODEL       || 'llama3.1:70b', // back-compat / legacy callers
  ollamaModelFast: process.env.OLLAMA_MODEL_FAST  || 'llama3.2:3b',  // quick chat (fallback: qwen2.5:7b)
  ollamaModelHeavy: process.env.OLLAMA_MODEL_HEAVY || process.env.OLLAMA_MODEL || 'llama3.3:70b', // reasoning/code
  ollamaModelVision: process.env.OLLAMA_MODEL_VISION || 'qwen2.5vl:7b', // screen + camera understanding
  cameraIndex: process.env.HANNIBAL_CAMERA_INDEX || '0', // fallback only: the camera is picked by name (HANNIBAL_CAMERA, default OBSBOT), see services/camera-device.js
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
  // Answer only when called "Hannibal" (outside a conversation). HANNIBAL_NAME_GATE=0 → answer everything.
  nameGate: !/^(0|false|off|no)$/i.test(process.env.HANNIBAL_NAME_GATE || ''),
  nameFollowUpMs: Number(process.env.HANNIBAL_FOLLOW_UP_S || 20) * 1000,
  // Who is talking + is it meant for him (src/addressee.js). HANNIBAL_ADDRESSEE=0
  // goes back to the plain name gate.
  addressee: !/^(0|false|off|no)$/i.test(process.env.HANNIBAL_ADDRESSEE || ''),
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
      // While Hannibal is driving the Mac, the wake word means STOP.
      if (computer.driving && computer.abort('wake word')) return;
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

// ── WHISPER: start Hannibal's speech-to-text server (electron/services/stt-server.js)
// if not up. It keeps whisper.cpp loaded on the GPU and picks the best model on
// disk (large-v3-turbo when present). An OLD HoloAssistant server still holding
// the port is replaced, so the new ears are always the ones used.
async function ensureWhisper() {
  const health = await fetch(CONFIG.whisperUrl + '/health', { signal: AbortSignal.timeout(1500) })
    .then((r) => (r.ok ? r.json().catch(() => ({})) : null)).catch(() => null);
  if (health && health.engine === 'hannibal-stt') { console.log('[whisper] already running (' + health.model + ')'); return; }
  if (health) {
    console.log('[whisper] old speech server on the port — replacing it');
    try { require('child_process').execSync("pkill -f 'HoloAssistant/ui/whisper-server.js'"); } catch (_) {}
    await new Promise((r) => setTimeout(r, 800));
  }
  whisperProc = spawn(CONFIG.node, [CONFIG.whisperScript], {
    cwd: path.dirname(CONFIG.whisperScript),
    env: process.env,
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
function runTts(cmd, args, stdinText, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: process.env });
    let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch (_) {} reject(new Error('tts timed out')); }, timeoutMs);
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

const { speakToMp3 } = require('./services/fast-tts');
let lastSpokeAt = 0;   // self-update waits until he has been quiet a while before restarting
ipcMain.handle('voice:tts', async (_e, text) => {
  lastSpokeAt = Date.now();
  // Unique per call — two sentences requested in the same millisecond must not share a file.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = `/tmp/hannibal-tts-${stamp}.mp3`;
  const t0 = Date.now();
  let fastErr = null;
  // Fast path: ElevenLabs straight from Node (electron/services/fast-tts.js).
  if (process.env.HANNIBAL_FAST_TTS !== '0' && process.env.ELEVENLABS_API_KEY) {
    try {
      const buf = await speakToMp3(text, { timeoutMs: 15000 });
      console.log(`[tts] ElevenLabs (fast, ${Date.now() - t0} ms): ${String(text || '').length} chars → ${buf.length} bytes of audio`);
      return buf;
    } catch (e) { fastErr = e; console.warn('[tts] fast voice failed, trying the old path:', e.message); }
  }
  // Second try through nova-tts.py. He only ever speaks in his own voice: no
  // macOS robot voice. If both fail the error goes back to the renderer, which
  // logs the dropout (stage "tts") and moves on to the next sentence.
  try {
    await runTts(CONFIG.pythonTTS, [CONFIG.ttsScript, file], String(text || ''), 25000);
    const buf = fs.readFileSync(file);
    console.log(`[tts] ElevenLabs: ${String(text || '').length} chars → ${buf.length} bytes of audio`);
    return buf; // arrives in renderer as a Uint8Array
  } catch (e) {
    throw new Error(`ElevenLabs failed${fastErr ? ` (fast: ${fastErr.message})` : ''}: ${e.message}`.slice(0, 400));
  } finally { fs.unlink(file, () => {}); }
});

// Every voice dropout is written down (services/voice-drops.js) so Hannibal can
// answer "did your voice drop out today?" (tool voice.dropouts).
const { createVoiceDropLog, registerVoiceDrops } = require('./services/voice-drops');
const voiceDrops = createVoiceDropLog();
registerVoiceDrops(ipcMain, voiceDrops, { where: 'desk' });
// Who is talking (services/speaker-id.js, run by the speech server): recent
// tags for the voice.who tool, and how many people the camera sees right now
// (a hint for "is Fred talking to someone else?", src/addressee.js).
ipcMain.handle('voice:who', async (_e, n) => {
  try {
    const r = await fetch(`${CONFIG.whisperUrl}/speaker/recent?n=${Number(n) || 20}`, { signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch (e) { return { ok: false, error: `speech server not reachable: ${e.message}` }; }
});
ipcMain.handle('room:people', () => { try { return faceFollow.people(); } catch (_) { return null; } });

// System metrics, calendar, mail and web live in services/info-handlers.js
// Place reminders ("when I get home / land in Ibiza / leave the office") live
// on the server, because Fred's iPhone app watches the places. The desk passes
// them on while it is linked.
const viaServer = (method, params) => (linked()
  ? bodyLink.request(method, params).catch((e) => ({ ok: false, error: `The server didn't answer: ${e.message}` }))
  : Promise.resolve({ ok: false, error: 'That runs on the server (through Fred\'s iPhone), and the desk is not linked to it right now. Ask me on the phone or Telegram.' }));
ipcMain.handle('reminders:place', (_e, message, place, on) => viaServer('reminders.place', { message, place, on }));
ipcMain.handle('reminders:places', () => viaServer('reminders.places', {}));
ipcMain.handle('reminders:cancelPlace', (_e, query) => viaServer('reminders.cancelPlace', { query }));
ipcMain.handle('nav:go', (_e, destination) => viaServer('nav.go', { destination }));
ipcMain.handle('nav:eta', (_e, destination) => viaServer('nav.eta', { destination }));

// (shared with the always-on server, server/hannibal-server.js).
// Reminders linked to calendar events (booked "with a reminder 15 minutes
// before"): the desk's own list, plus the server's while linked (one booked
// from the phone lives there).
const { createLinkedReminders } = require('./services/proactive');
const linkedReminders = proactive && proactive.reminders ? createLinkedReminders({
  local: proactive.reminders,
  remote: {
    list: async () => (linked() ? ((await bodyLink.request('reminders.linked', {})) || {}).reminders || [] : []),
    cancel: (id) => bodyLink.request('reminders.cancelId', { id }),
    retime: (id, ts) => bodyLink.request('reminders.retime', { id, ts }),
  },
}) : null;
const info = registerInfo(ipcMain, { python: CONFIG.pythonTTS, searxngUrl: CONFIG.searxngUrl, reminders: linkedReminders });
claudeTools.setPreflight(info.calendarPreflight, 'calendar');

// NUDGES (services/nudges.js): Hannibal brings things up himself (a meeting
// about to start, a trip, a person's mail waiting days for an answer), at a
// quiet moment and never while Fred is in the zone. The desk speaks them; the
// server (on the phone) knows which ones were already said.
const { createNudger, createZoneWatcher, knownPeople } = require('./services/nudges');
const zoneWatch = createZoneWatcher({
  sample: async () => {
    const { frontmost } = require('./services/awareness');
    const [front, idle] = await Promise.all([frontmost(), hidIdleSeconds()]);
    return { app: front.app, title: front.title, idle };
  },
});
function hidIdleSeconds() {
  return new Promise((resolve) => {
    require('child_process').execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (e, out) => {
      const m = !e && String(out).match(/"HIDIdleTime"\s*=\s*(\d+)/);
      resolve(m ? Number(m[1]) / 1e9 : 9999);
    });
  });
}
const pendingNudges = new Map();   // id → resolve(ok)
let nudgeSeq = 0;
const nudger = createNudger({
  getEvents: () => info.calendar(8),
  getMail: () => info.waitingMail(48, 7),
  isKnown: (m) => knownPeople(deskFacts.all().map((f) => f.text).join('\n'))(m),
  zone: () => zoneWatch.status(),
  skip: (n) => deskThreads.isClosedTopic(n.text),
  // Spoken at the desk, at a quiet moment (the renderer waits up to 10 min for one).
  deliver: (n) => new Promise((resolve) => {
    const id = `n${++nudgeSeq}`;
    const timer = setTimeout(() => { pendingNudges.delete(id); resolve(false); }, 12 * 60 * 1000);
    pendingNudges.set(id, (ok) => { clearTimeout(timer); resolve(!!ok); });
    try { win && !win.isDestroyed() ? win.webContents.send('proactive:run', { kind: 'nudge', id, prompt: n.prompt, urgent: !!n.urgent }) : (clearTimeout(timer), resolve(false)); }
    catch (_) { clearTimeout(timer); resolve(false); }
  }),
  quietText: async (n) => {
    if (!linked()) return false;
    try { await bodyLink.request('phone.notify', { text: `⏰ ${n.text}`, voice: false }); return true; } catch (_) { return false; }
  },
  onSaid: (keys) => { if (linked()) bodyLink.request('nudge.said', { keys }).catch(() => {}); },
});
setTimeout(() => {
  zoneWatch.poll();
  setInterval(async () => { await zoneWatch.poll(); nudger.tick().catch((e) => console.warn('[nudge] tick failed:', e.message)); }, 60 * 1000);
}, 90 * 1000);

ipcMain.handle('voice:config', () => ({
  whisperUrl: CONFIG.whisperUrl,
  sttLanguage: process.env.HANNIBAL_STT_LANG || 'auto',
  ollamaUrl: CONFIG.ollamaUrl,
  ollamaModel: CONFIG.ollamaModel,
  ollamaModelFast: CONFIG.ollamaModelFast,
  ollamaModelHeavy: CONFIG.ollamaModelHeavy,
  ollamaModelVision: CONFIG.ollamaModelVision,
  alwaysListen: CONFIG.alwaysListen,
  nameGate: CONFIG.nameGate,
  nameFollowUpMs: CONFIG.nameFollowUpMs,
  addressee: CONFIG.addressee,
  nudgeIdleMs: (Number(process.env.HANNIBAL_NUDGE_IDLE_S) || 25) * 1000,   // quiet gap before a nudge
  bargeIn: process.env.HANNIBAL_BARGE_IN !== '0',   // talk over him to cut him off
  bargeMinBar: Number(process.env.HANNIBAL_BARGE_BAR) || 0,   // mic level that counts as Fred talking (default 0.006)
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

// Grab ONE downscaled frame from the OBSBOT (avfoundation, picked by name).
// Extracted so both voice:capture (kind 'camera') and camera.look reuse the
// SAME device selection — there is no second camera path.
let cameraPicker = null;
async function captureCameraFrame() {
  if (!cameraPicker) cameraPicker = createCameraPicker({ ffmpeg: CONFIG.ffmpeg, fallbackIndex: CONFIG.cameraIndex });
  const first = await grabFrame(await cameraPicker.resolve());
  if (first.ok) return first;
  // Cameras come and go (an iPhone nearby shifts the list): re-check once.
  const again = await cameraPicker.resolve({ fresh: true });
  return grabFrame(again);
}

async function grabFrame(cameraInput) {
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
                '-video_size', '1280x720', '-i', cameraInput,
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
    const timer = setTimeout(() => {
      ipcMain.removeAllListeners(channel);
      console.warn(`[gate] ${step.tool}: no answer in ${timeoutMs / 1000}s → not done`);
      resolve({ approved: false, answer: 'unheard' });
    }, timeoutMs);
    // The renderer answers { approved, answer:'yes'|'no'|'unheard' } (or a bare
    // boolean from older code). Only approved === true runs the action.
    ipcMain.once(channel, (_e, ok) => {
      clearTimeout(timer);
      const ans = (ok && typeof ok === 'object') ? { approved: ok.approved === true, answer: ok.answer } : { approved: ok === true };
      // The log says what the yes (or no) was to: the exact question Fred heard.
      console.log(`[gate] ${step.tool}: ${ans.approved ? 'YES → running it' : `${ans.answer === 'unheard' ? 'no clear answer' : 'NO'} → not done`} (asked: "${String(summary || '').slice(0, 200)}")`);
      resolve(ans);
    });
    // expiresAt lets a request that waited in the renderer's queue too long be
    // skipped instead of asked (main would ignore that answer anyway).
    target.webContents.send('agent:confirm-request', { id, step: step.step, tool: step.tool, summary, expiresAt: Date.now() + timeoutMs - 5000 });
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
    .setHandler('body.invoke', async ({ tool, params }) => {
      if (/^computer\./.test(String(tool))) return { ok: false, error: 'computer control only runs at the desk' };
      return macInvoker(tool, params);
    })
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
// The Mac as Hannibal's BODY: while awake it links to the always-on server, so
// from the phone Hannibal can use this Mac's tools (the server asks Fred on his
// phone before anything that changes something), and facts stay shared.
function startBodyLink() {
  const token = (process.env.BODY_LINK_TOKEN || '').trim();
  if (!/^(1|true|on|yes)$/i.test(process.env.HANNIBAL_SERVER_TELEGRAM || '') || !token) return;
  const { BrainClient } = require('./services/brain/client');
  const macInvoker = makeIpcInvoker(installToolTap._registry || {});
  let wasLinked = false;
  bodyLink = new BrainClient({
    url: process.env.HANNIBAL_BODY_URL || 'ws://100.99.70.113:8790',
    token, bodyId: 'mac', reconnect: true,
    timeouts: { default: 20000 },
  });
  bodyLink
    .setHandler('body.invoke', async ({ tool, params }) => {
      console.log('[body] server runs on the Mac:', tool);
      // The hands (keyboard/mouse) are desk-only: never driven from the phone.
      if (/^computer\./.test(String(tool))) return { ok: false, error: 'computer control only runs at the desk' };
      return macInvoker(tool, params || {});
    })
    .on('ready', async () => {
      wasLinked = true;
      console.log('[body] ✓ linked to the always-on server');
      try {
        await bodyLink.request('body.register', { channels: Object.keys(installToolTap._registry || {}).filter((c) => !/^computer(:|$)/.test(c)) });
        const r = await bodyLink.request('facts.sync', { facts: deskFacts.all(), lastSynced: lastSyncedFacts() });
        applyServerFacts(r && r.facts);
        const ns = await bodyLink.request('nudge.sync', { keys: nudger.said() }).catch(() => null);
        if (ns && ns.keys) nudger.markSaid(ns.keys);
        const j = await bodyLink.request('journal.sync', { episodes: deskJournal.all() });
        const got = deskJournal.merge(j && j.episodes);
        const th = await bodyLink.request('threads.sync', { threads: deskThreads.all() }).catch(() => null);
        if (th && th.threads) deskThreads.merge(th.threads);
        console.log(`[body] diary in sync with the server (${deskJournal.size} conversations${got ? `, ${got} new from the phone` : ''})`);
      } catch (e) { console.warn('[body] setup after link failed:', e.message); }
    })
    .on('event', (name, data) => {
      if (name === 'facts') applyServerFacts(data && data.facts);
      if (name === 'journal') deskJournal.merge(data && data.episodes);
      if (name === 'threads') deskThreads.merge(data && data.threads);
    })
    .on('close', () => { if (wasLinked) console.warn('[body] link to the server dropped, reconnecting'); wasLinked = false; })
    .on('error', () => {});   // routine connect errors while offline; the reconnect loop handles them
  bodyLink.connect();
}

function startTelegram() {
  // When the always-on server (server/hannibal-server.js on GEX131) runs the
  // bot, the Mac must not: Telegram allows only one listener per bot.
  if (/^(1|true|on|yes)$/i.test(process.env.HANNIBAL_SERVER_TELEGRAM || '')) {
    console.log('[telegram] handled by the always-on server (HANNIBAL_SERVER_TELEGRAM=1), not started here');
    return;
  }
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
    memory: sharedMemory(),
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

// Hannibal's mouth + ears on Apple voice processing, so Fred can talk over him.
const voiceIO = createVoiceIO({ send: (ch, data) => { try { win && win.webContents.send(ch, data); } catch (_) {} } });
voiceIO.register(ipcMain);

app.whenReady().then(async () => {
  voiceIO.start().catch((e) => console.warn('[voice-io] start failed', e.message));
  // Back from sleep / screen unlocked: the speakers may be different now. The
  // voice helper starts fresh and the page rebuilds its audio output.
  const onWake = (why) => {
    console.log(`[voice] ${why}: refreshing his voice output`);
    voiceIO.refresh(why);
    try { win && win.webContents.send('power:resume', { why }); } catch (_) {}
  };
  try {
    powerMonitor.on('resume', () => onWake('the Mac woke up'));
    powerMonitor.on('unlock-screen', () => onWake('the screen was unlocked'));
  } catch (e) { console.warn('[voice] no power events:', e.message); }
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
  computer.warm().then((r) => { if (r && r.trusted) console.log(`[computer] hands ready (Esc×3 stop ${r.esc ? 'on' : 'off'})`); });
  startBrain();   // links this Mac as a BODY to the GEX131 brain when HANNIBAL_BRAIN=1
  ensureWhisper();
  startTelegram();  // Hannibal on Fred's phone, when TELEGRAM_BOT_TOKEN is set
  startBodyLink();  // …or, with the always-on server, link this Mac to it as Hannibal's body
  startSelfUpdate();  // a merged PR goes live by itself (services/self-update.js)
  if (process.env.HANNIBAL_CAMERA_FOLLOW !== '0') faceFollow.start();  // turn the OBSBOT to keep Fred in frame
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
  try { voiceIO.quit(); } catch (_) {}
  try { computerHands.quit(); } catch (_) {}
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
