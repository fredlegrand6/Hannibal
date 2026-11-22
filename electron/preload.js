// Preload bridge between main and renderer (exposes window.hannibal).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hannibal', {
  // brain state — main can drive these (voice/vision/proactive engines)
  onSetState: (cb) => ipcRenderer.on('hannibal:set-state', (_e, state) => cb(state)),
  onSetAmplitude: (cb) => ipcRenderer.on('hannibal:set-amplitude', (_e, value) => cb(value)),

  // voice pipeline
  onWake: (cb) => ipcRenderer.on('voice:wake', () => cb()),
  // streaming silero VAD — real speech/not-speech (knows voice from music)
  onVad: (cb) => ipcRenderer.on('voice:vad', (_e, ev) => cb(ev)),     // { type:'ready'|'start'|'end'|'error' }
  vadControl: (cmd) => ipcRenderer.send('voice:vad-control', cmd),    // 'PAUSE'|'RESUME'|'THRESH x'|'SILENCE ms'
  tts: (text) => ipcRenderer.invoke('voice:tts', text),
  // Voice helper (Apple echo cancelling): play his voice, cut it, and grab clean mic clips.
  vioStatus: () => ipcRenderer.invoke('vio:status'),
  vioPlay: (bytes, ms) => ipcRenderer.invoke('vio:play', bytes, ms),
  vioStop: () => ipcRenderer.invoke('vio:stop'),
  vioWarm: () => ipcRenderer.invoke('vio:warm'),
  vioRelease: () => ipcRenderer.invoke('vio:release'),
  vioClip: (ms) => ipcRenderer.invoke('vio:clip', ms),
  onVioLevel: (cb) => ipcRenderer.on('vio:level', (_e, m) => cb(m)),
  onVioReady: (cb) => ipcRenderer.on('vio:ready', (_e, m) => cb(m)),     // -> Uint8Array (MP3 bytes)
  // Claude chat brain (runs in main; the API key never reaches the renderer).
  // payload: { system, context, user } · onToken(text) fires as the reply streams.
  // -> { ok, text, model, usage } | { ok:false, error }  (caller falls back to Ollama)
  claudeChat: (payload, onToken) => {
    const id = `c${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const onTok = (_e, m) => { if (m && m.id === id && onToken) onToken(m.text); };
    ipcRenderer.on('llm:token', onTok);
    return ipcRenderer.invoke('llm:chat', { ...payload, id })
      .finally(() => ipcRenderer.removeListener('llm:token', onTok));
  },
  claudeInterrupt: () => ipcRenderer.invoke('llm:interrupt'),  // barge-in: stop the reply in flight
  claudeReset: () => ipcRenderer.invoke('llm:reset'),       // forget the running conversation
  claudeNote: (text) => ipcRenderer.invoke('llm:note', text), // tell the brain about something done outside the chat
  config: () => ipcRenderer.invoke('voice:config'),         // -> { whisperUrl, ollamaUrl, ollamaModel, ... }
  capture: (kind) => ipcRenderer.invoke('voice:capture', kind), // 'screen'|'camera' -> { ok, b64 }
  systemMetrics: () => ipcRenderer.invoke('system:metrics'),    // -> { ok, gpu, mem, cpu, net }
  calendarEvents: () => ipcRenderer.invoke('calendar:events'),  // -> { ok, events:[{time,title,day,allDay}] }
  mailInbox: () => ipcRenderer.invoke('mail:inbox'),            // -> { ok, unread, messages:[{from,subject,time,unread,uid}] }
  readMailBody: (uid) => ipcRenderer.invoke('mail:read-body', uid), // -> { ok, from, subject, date, body }

  // World Awareness — dual-dispatch: opens the WorldMonitor view (eyes) +
  // returns a live narrated read (ears). worldRead(topic) routes any topic via
  // the Stage-2 router; worldCrypto() is the Stage-1 back-compat shortcut.
  worldRead: (topic, opts) => ipcRenderer.invoke('world:read', { topic, ...(opts || {}) }), // -> { ok, topic, narration, worldRead, viewOpened, degraded, declined? }
  worldCrypto: (opts) => ipcRenderer.invoke('world:crypto', opts || {}), // -> { ok, narration, worldRead, viewOpened, degraded }

  // self-learning alias system — data/aliases.json
  loadAliases: () => ipcRenderer.invoke('aliases:load'),        // -> { ok, data: { names:{}, commands:{} } }
  saveAliases: (data) => ipcRenderer.invoke('aliases:save', data), // -> { ok }

  // behavior log — data/behavior-log.json, append-only, FIFO-capped
  logBehavior: (command) => ipcRenderer.invoke('behavior:log', command), // -> { ok }
  listBehavior: () => ipcRenderer.invoke('behavior:list'),               // -> { ok, logs:[] }

  // learned preferences — data/preferences.json
  loadPreferences: () => ipcRenderer.invoke('preferences:load'),         // -> { ok, data:{...} }
  savePreferences: (data) => ipcRenderer.invoke('preferences:save', data), // -> { ok }

  // user-taught skills — data/skills.json
  loadSkills: () => ipcRenderer.invoke('skills:load'),                   // -> { ok, skills:[] }
  saveSkills: (skills) => ipcRenderer.invoke('skills:save', skills),     // -> { ok }
  executeSkill: (skill) => ipcRenderer.invoke('skills:execute', skill),  // -> { ok, output, error }

  // personality + relationship + mood history — data/personality.json
  loadPersonality: () => ipcRenderer.invoke('personality:load'),         // -> { ok, data:{...} }
  savePersonality: (data) => ipcRenderer.invoke('personality:save', data), // -> { ok }

  // web read — fetch URL through main, returns plain-text body
  fetchUrl: (url) => ipcRenderer.invoke('web:fetch', url),               // -> { ok, url, title, text }
  // SearXNG-backed search — main holds the URL, returns top results as JSON
  webSearch: (query) => ipcRenderer.invoke('web:search', query),         // -> { ok, results:[{url,title,content,...}] }
  // clipboard write via pbcopy in main (handles tricky strings cleanly)
  setClipboard: (text) => ipcRenderer.invoke('clipboard:set', text),     // -> { ok }
  // persisted lists — data/reminders.json, notes.json, timers.json
  loadReminders: () => ipcRenderer.invoke('reminders:load'),             // -> { ok, reminders:[] }
  saveReminders: (list) => ipcRenderer.invoke('reminders:save', list),   // -> { ok }
  onRemindersChanged: (cb) => ipcRenderer.on('reminders:changed', () => cb()),
  onNotesChanged: (cb) => ipcRenderer.on('notes:changed', () => cb()),          // main (Claude) changed the notes → reload   // main (Claude) changed the list → reload
  onProactiveRun: (cb) => ipcRenderer.on('proactive:run', (_e, job) => cb(job)),  // { kind:'morning-brief', day, prompt }
  proactiveDone: (r) => ipcRenderer.invoke('proactive:done', r),                 // { kind, day, ok, text }
  reminderFired: (message) => ipcRenderer.invoke('reminders:fired', message),
  // long-term memory (Qdrant, in main): keep-or-skip + dedupe on store, picky recall
  memoryStore: (text, metadata) => ipcRenderer.invoke('memory:store', { text, metadata }), // -> { ok }
  memorySearch: (text, limit) => ipcRenderer.invoke('memory:search', { text, limit }),    // -> [{ text, score, ts, type }]   // → also sent to Fred's phone
  loadNotes: () => ipcRenderer.invoke('notes:load'),                     // -> { ok, notes:[] }
  saveNotes: (list) => ipcRenderer.invoke('notes:save', list),           // -> { ok }
  loadTimers: () => ipcRenderer.invoke('timers:load'),                   // -> { ok, timers:[] }
  saveTimers: (list) => ipcRenderer.invoke('timers:save', list),         // -> { ok }

  // system / browser control (ported from V1)
  browserAction: (action, params) => ipcRenderer.invoke('browser-action', action, params),
  macControl: (action, params) => ipcRenderer.invoke('mac-control', action, params),
  // camera steering (OBSBOT Tiny 3 over OSC) — action ∈ aim|zoom|track|preset|reset|status|look
  cameraControl: (action, params) => ipcRenderer.invoke('camera:control', action, params), // -> { ok, ... } (look also returns { b64 })

  // claude code live sessions (Agents panel) — main pushes cc:event, renderer hydrates via getSessions
  onCcEvent: (cb) => ipcRenderer.on('cc:event', (_e, payload) => cb(payload)),
  getSessions: () => ipcRenderer.invoke('cc:getSessions'),       // -> [{ session_id, project, hostname, status, lastAction, lastTool, startedAt, updatedAt }]

  // agent loop — run a goal/plan through the gated executor; progress streams back
  runAgent: (arg) => ipcRenderer.invoke('agent:run', arg),       // arg: { goal } | { plan } -> { ok, record }
  runSkill: (name, args) => ipcRenderer.invoke('skill:run', { name, args }), // named skill -> { ok, record, results }
  onAgentProgress: (cb) => ipcRenderer.on('agent:progress', (_e, ev) => cb(ev)),
  // confirmation gate — main asks before each confirm:true write; renderer speaks
  // the summary, shows it, and replies with the user's yes/no for that exact id.
  onAgentConfirmRequest: (cb) => ipcRenderer.on('agent:confirm-request', (_e, req) => cb(req)),
  agentConfirmResponse: (id, ok) => ipcRenderer.send(`agent:confirm-response:${id}`, ok),

  // continuous awareness (Stage 7) — opt-in screen-watch loop. Default OFF.
  awarenessStart: (patch) => ipcRenderer.invoke('awareness:start', patch),   // -> { ok, watching }
  awarenessStop: () => ipcRenderer.invoke('awareness:stop'),                  // -> { ok, watching }
  awarenessStatus: () => ipcRenderer.invoke('awareness:status'),             // -> { watching, config }
  awarenessConfig: (patch) => ipcRenderer.invoke('awareness:config', patch), // get (no arg) / live-set (patch)
  onAwarenessState: (cb) => ipcRenderer.on('awareness:state', (_e, s) => cb(s)),           // { watching }
  onAwarenessTick: (cb) => ipcRenderer.on('awareness:tick', (_e, t) => cb(t)),             // per-changed-frame telemetry
  onAwarenessObservation: (cb) => ipcRenderer.on('awareness:observation', (_e, o) => cb(o)), // struggle fired → speak gate

  // presence loop (autonomous, read-only)
  presenceControl: (cmd) => ipcRenderer.invoke('presence:control', cmd),   // 'mute'|'unmute'|'sleep'|'wake'|'start'|'stop' -> { ok, ... }
  presenceStatus: () => ipcRenderer.invoke('presence:status'),             // -> { running, muted, sleeping, recentActions }
  presenceConfig: (patch) => ipcRenderer.invoke('presence:config', patch), // get / live-set
  presenceHeard: (text) => ipcRenderer.invoke('presence:heard', text),     // feed last user utterance for conversational context
  onPresenceState: (cb) => ipcRenderer.on('presence:state', (_e, s) => cb(s)),   // { running, muted, sleeping }
  onPresenceRemark: (cb) => ipcRenderer.on('presence:remark', (_e, r) => cb(r)), // { text, interest, ts } → speak gate
  onPresenceAction: (cb) => ipcRenderer.on('presence:action', (_e, a) => cb(a)), // autonomous action log (incl. refusals)
});
