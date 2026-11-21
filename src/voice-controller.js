// ─────────────────────────────────────────────────────────────────────────
// Voice pipeline controller — ports Hannibal V1's flow into V2 and drives the
// neural-brain state machine automatically:
//
//   wake word        -> brain.setState('listening')   + mic capture
//   silence detected -> brain.setState('thinking')    + Whisper + Ollama
//   TTS playing      -> brain.setState('speaking')    + live amplitude
//   done speaking    -> back to 'listening' for 5s (conversation mode) — a follow-up
//                       within the window is processed wake-word-free; otherwise -> 'idle'
//
// ALWAYS-LISTEN (cfg.alwaysListen, default ON — HANNIBAL_ALWAYS_LISTEN=0 to disable):
//   the RESTING state is no longer 'idle' but a continuously open mic. The wake
//   word becomes OPTIONAL: silero VAD alone marks where each utterance begins and
//   ends, and every utterance flows through the exact same command/chat path
//   (so lastHeard/presence AND the planner/executor still fire) WITHOUT needing
//   "Hey Hannibal". After each turn the mic re-arms instead of dropping to idle.
//   `continuousListen` is the live switch — "go idle" stands it down, the wake
//   word (or "wake up") brings it back. With the flag off, behavior is identical
//   to the classic wake-word flow above. This changes only INPUT (hearing): the
//   write-confirmation gate and the presence read-only boundary are untouched.
//
// Key change from V1: TTS is played here via Web Audio (not afplay in the main
// process), so an AnalyserNode can feed real amplitude into the speaking state.
// ─────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are Hannibal, Fred's personal AI assistant. Be concise, direct, and " +
  "natural — you're spoken aloud, so keep replies short and conversational. " +
  "You have long-term memory — if relevant memories are provided below, use them " +
  "naturally without mentioning the memory system.";

// ── Qdrant vector memory ────────────────────────────────────────────────────
// GEX131 runs Qdrant with the hannibal_memory collection (768-dim, nomic-embed-text).
// Before each LLM turn we embed the user's query, pull the top 3 relevant memories,
// and inject them as additional system context. After each turn we store the exchange.
// Default = GEX131's Tailscale IP; overridden from main's config (QDRANT_URL in .env).
let QDRANT_URL = 'http://100.99.70.113:6333';
// Qdrant on GEX131 requires an API key (QDRANT_API_KEY in .env, passed via config).
let QDRANT_HEADERS = { 'Content-Type': 'application/json' };
const QDRANT_COLLECTION = 'hannibal_memory';

async function ensureQdrantCollection(ollamaUrl) {
  try {
    const r = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}`, { headers: QDRANT_HEADERS, signal: AbortSignal.timeout(3000) });
    if (r.ok) return true;
    // Create the collection (nomic-embed-text = 768 dim)
    const cr = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}`, {
      method: 'PUT',
      headers: QDRANT_HEADERS,
      body: JSON.stringify({ vectors: { size: 768, distance: 'Cosine' } }),
      signal: AbortSignal.timeout(5000),
    });
    console.log('[memory] created collection:', cr.ok);
    return cr.ok;
  } catch (e) {
    console.warn('[memory] qdrant unreachable:', e.message);
    return false;
  }
}

// Recall and store go through main (electron/services/qdrant-memory.js), which
// owns the rules: small talk and noise are not kept, near-duplicates are
// skipped, and recall only returns hits that are really relevant.
async function queryMemory(text, _ollamaUrl, limit = 3) {
  try {
    const hits = await window.hannibal.memorySearch(text, limit);
    return Array.isArray(hits) ? hits : [];
  } catch (e) {
    console.warn('[memory] query failed:', e.message);
    return [];
  }
}

async function storeMemory(text, _ollamaUrl, metadata = {}) {
  try {
    const r = await window.hannibal.memoryStore(text, metadata);
    if (r && r.ok) console.log('[memory] stored:', text.slice(0, 60));
  } catch (e) {
    console.warn('[memory] store failed:', e.message);
  }
}

const SILENCE_MS = 2500;        // end the utterance after this much trailing quiet
const SILENCE_THRESH = 15;      // LEGACY fixed floor — kept for the confirm-gate path; the main
                                // listen loop now calibrates a per-room floor (see below).
const SPEECH_ONSET_SAMPLES = 3; // consecutive loud 100ms samples (~300ms) = real speech, not a blip
const CONVERSATION_WINDOW_MS = 5000; // allowed time to START speaking before dropping to idle
// ALWAYS-LISTEN: how long the continuously-open mic waits (in silence) before it
// recycles — closes and reopens to flush the recorder buffer and keep memory
// bounded. Longer than the 5s follow-up window purely to cut getUserMedia churn
// and shrink the sub-second reopen gap where an utterance onset could be clipped.
const CONTINUOUS_RECYCLE_MS = 20000;
// ── Adaptive voice-activity detection (fixes the "stuck in LISTENING" hang) ──
// A fixed cutoff fails when the room's noise floor sits above it: every sample
// reads as "sound", so end-of-utterance never fires and the recorder runs
// forever. Instead we measure the ambient floor and key both onset and release
// off it, with hysteresis + a relative-drop test + a hard max length.
const NOISE_ONSET_MARGIN = 14;    // speech must exceed the measured floor by this to START a turn
const NOISE_RELEASE_MARGIN = 7;   // …and fall back within this of the floor to count as a PAUSE (hysteresis)
const SILENCE_DROP_RATIO = 0.45;  // a pause also = level dropped below this fraction of the running speech level
const MAX_UTTERANCE_MS = 15000;   // hard cap: force-close + process even if a pause is never detected
const NOISE_CAL_SAMPLES = 12;     // ~850ms ambient sample taken once at startup

export async function initVoice(brain, { onPhase, onUser, onAssistant, onModel, onConfirm, onWatching } = {}) {
  const cfg = await window.hannibal.config();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Load the self-learning alias map from disk before any transcript is seen.
  // Empty map is a safe default if load fails — fixTranscript still works.
  await loadAliasesFromDisk();
  // Load learned preferences too. Safe to fire-and-forget in parallel but
  // the await keeps initVoice deterministic for tests.
  await loadPreferencesFromDisk();
  // User-taught skills (data/skills.json).
  await loadSkillsFromDisk();
  // Personality + relationship + mood history.
  await loadPersonalityFromDisk();
  // Reminders / notes / timers — persisted JSON lists, loaded once at init.
  await loadReminders();
  await loadNotes();
  await loadTimers();

  // Tracks the most recent dispatched task so subsequent corrections /
  // interruptions / model-switches know which bucket to attribute to.
  let lastTaskType = null;

  // ── Context state ─────────────────────────────────────────────────────────
  // recentTasks is a rolling window of the last 5 task-type strings (FIFO).
  // activityModeFromTasks(recentTasks) gives us "dev"/"admin"/"general" for
  // the context preamble. lastActivityTime updates on every command so the
  // wake handler can decide whether to add "welcome back" to the greeting.
  // lastGreetingTime suppresses re-greeting on rapid wake bursts (within 5m).
  const recentTasks = [];
  const recentTaskTimes = [];     // parallel ms timestamps for detecting "rapid" cadence
  function noteTask(t) {
    if (!t) return;
    recentTasks.push(t);
    recentTaskTimes.push(Date.now());
    while (recentTasks.length > 5) { recentTasks.shift(); recentTaskTimes.shift(); }
  }
  let lastActivityTime = Date.now();
  let lastGreetingTime = 0;
  function noteActivity() { lastActivityTime = Date.now(); }

  // Fred's mood (heuristically detected from each utterance + recent cadence).
  // Lives ONLY in this closure — kept separate from PERSONALITY.emotional_state,
  // which is HANNIBAL's own state (proud/determined/grateful — set elsewhere).
  // mood_history on disk records Fred's mood transitions, not Hannibal's.
  let currentMood = 'neutral';
  // "Currently displayed" email — set when Fred clicks a mail-item in the
  // left rail OR after readEmailViaIMAP speaks one. Treated as fresh for
  // ACTIVE_EMAIL_TTL_MS so "read this email" right after a click reads the
  // CLICKED one rather than fetching IMAP's newest unread. Cleared on
  // staleness inside the read path.
  const ACTIVE_EMAIL_TTL_MS = 10 * 60 * 1000;
  let activeEmail = null;   // { from, subject, date, body, ts }
  function setActiveEmail(email) {
    if (!email || !email.body) { activeEmail = null; return; }
    activeEmail = {
      from: String(email.from || ''),
      subject: String(email.subject || ''),
      date: String(email.date || ''),
      body: String(email.body || ''),
      ts: Date.now(),
    };
    console.log('[mail] active email set:', activeEmail.subject.slice(0, 60));
  }
  function freshActiveEmail() {
    if (!activeEmail) return null;
    if (Date.now() - activeEmail.ts > ACTIVE_EMAIL_TTL_MS) {
      console.log('[mail] active email expired');
      activeEmail = null;
      return null;
    }
    return activeEmail;
  }
  // Detected language for Fred's last utterance. Sticky-on-no-signal: a single
  // short reply like "yes" or "ok" has zero markers and would otherwise reset
  // to English; we only update when detectLanguage gives a non-default answer
  // OR when the message is long enough that "English by default" is genuine.
  let currentLanguage = 'english';
  function updateLanguage(text) {
    const detected = detectLanguage(text);
    const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
    // Keep prior language on short signal-less utterances (yes/ok/ja/oui).
    if (detected === 'english' && words < 4 && currentLanguage !== 'english') return;
    if (detected !== currentLanguage) {
      console.log(`[lang] ${currentLanguage} → ${detected}`);
      currentLanguage = detected;
    }
  }
  function rapidCount() {
    const cutoff = Date.now() - 2 * 60 * 1000;   // last 2 minutes
    return recentTaskTimes.filter((ts) => ts >= cutoff).length;
  }
  function updateMood(text) {
    const ctx = getContext();
    const detected = detectMood(text, { hour: ctx.hour, recentRapid: rapidCount() });
    if (detected === currentMood) return;
    const prev = currentMood;
    currentMood = detected;
    // Append a transition to mood_history (skip no-op neutral→neutral). Capped
    // by main.js's save handler at 200 entries FIFO.
    if (PERSONALITY && (detected !== 'neutral' || prev !== 'neutral')) {
      (PERSONALITY.mood_history = PERSONALITY.mood_history || []).push({
        subject: 'fred', from: prev, to: detected, ts: Date.now(), task: lastTaskType || null,
      });
      savePersonality();   // fire-and-forget
    }
    console.log(`[mood:fred] ${prev} → ${detected}`);
  }

  // ── Hannibal's own emotional state ──
  // Stoic with warmth — these flip on specific triggers, persist until the
  // next trigger, no automatic decay. Surfaced in the system prompt so the
  // LLM colors its replies subtly (Alfred, not a puppy).
  //   proud      → after successfully teaching/saving a new skill
  //   determined → after a key action failed (skill exec error, no fuzzy match)
  //   grateful   → after Fred praises ("thanks", "good job", "nice work")
  //   neutral    → default
  function setHannibalState(state, reason) {
    if (!PERSONALITY) return;
    const prev = (PERSONALITY.emotional_state && PERSONALITY.emotional_state.current) || 'neutral';
    if (prev === state) return;
    PERSONALITY.emotional_state = {
      current: state,
      energy: state === 'proud' || state === 'grateful' ? 'warm'
            : state === 'determined' ? 'focused' : 'normal',
      last_updated: new Date().toISOString(),
    };
    (PERSONALITY.mood_history = PERSONALITY.mood_history || []).push({
      subject: 'hannibal', from: prev, to: state, ts: Date.now(), reason: reason || null,
    });
    savePersonality();
    console.log(`[mood:hannibal] ${prev} → ${state}${reason ? ` (${reason})` : ''}`);
  }
  function hannibalState() {
    return (PERSONALITY && PERSONALITY.emotional_state && PERSONALITY.emotional_state.current) || 'neutral';
  }

  // Build the preamble fresh each time so time/period/mode are current. Used
  // by every LLM system prompt below. Returns a string ending in a single
  // space — call sites concatenate directly with their existing prompt.
  //
  // Three things in the preamble, kept terse to preserve model attention:
  //   1. Base context (time/day/period/mode + tone hint)
  //   2. Personality + relationship (one line, compressed from PERSONALITY)
  //   3. Mood overlay (only when non-neutral) + care line (only when applicable)
  function buildPersonaLine() {
    if (!PERSONALITY) {
      return "You are Hannibal, Fred's personal AI. Stoic with warmth — dry wit, loyal, direct. No corporate fluff.";
    }
    // Compress the personality file into one line for prompt efficiency.
    // The verbose descriptions stay in personality.json for the user to edit;
    // the prompt gets the essence. Includes the relationship snapshot so the
    // LLM doesn't generic-assistant Fred about his own life. Reads
    // knows_people (new) and falls back to knows_family (legacy shape).
    const ppl = (PERSONALITY.relationship && (PERSONALITY.relationship.knows_people || PERSONALITY.relationship.knows_family)) || {};
    // Bucket each entry into family vs. partner so the prompt reads naturally.
    const family = [], partners = [];
    for (const [k, v] of Object.entries(ppl)) {
      const name = k.split(/[\s-]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
      // Skip aliases like "jean marc langerak: Same person as jean-marc"
      if (/^same person/i.test(v)) continue;
      const role = /wife/i.test(v) ? 'wife' : /son/i.test(v) ? 'son' : /daughter/i.test(v) ? 'daughter'
                : /best friend.*partner/i.test(v) ? 'best friend & partner' : /partner/i.test(v) ? 'partner' : '';
      if (role && (role.endsWith('partner') || role.includes('partner'))) partners.push(`${role} ${name}`);
      else if (role) family.push(`${role} ${name}`);
      else partners.push(name);
    }
    const famBit = family.length ? ` Family: ${family.join(', ')}.` : '';
    const partnerBit = partners.length ? ` Partners: ${partners.join(', ')}.` : '';
    return `You are ${PERSONALITY.name || 'Hannibal'}, Fred's personal AI — stoic with warmth, dry wit, confident, direct. Not a generic assistant; you have history with Fred.${famBit}${partnerBit} No corporate fluff.`;
  }

  // Proactive care: returns a short LLM-facing note when conditions warrant
  // (long working session, late-night focus, weekend early-morning grind).
  // Returns "" when nothing applies — keeps the preamble lean by default.
  function buildCareLine(ctx) {
    if (!recentTaskTimes.length) return '';
    // First command of today (or session) — for the "working too long" check.
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const startMs = recentTaskTimes[0];
    const hoursSinceFirst = (Date.now() - startMs) / (60 * 60 * 1000);
    if (hoursSinceFirst >= 12) {
      return ' Care note: Fred has been at it for 12+ hours — gently mention winding down if natural.';
    }
    if (ctx.hour >= 22 && rapidCount() >= 3) {
      return ' Care note: late hour and rapid commands — Fred is grinding; if natural, suggest wrapping up.';
    }
    if (ctx.isWeekend && ctx.period === 'early_morning' && startMs < dayStart.getTime() + 6 * 60 * 60 * 1000) {
      return ' Care note: weekend early morning, Fred up early — acknowledge briefly if natural.';
    }
    return '';
  }

  function ctxPreamble() {
    const ctx = getContext();
    const base = buildContextPreamble(ctx, activityModeFromTasks(recentTasks), PREFERENCES);
    const persona = buildPersonaLine();
    const moodLine = (currentMood && currentMood !== 'neutral')
      ? ` Fred currently seems ${currentMood.replace(/_/g, ' ')} — adapt tone (calm/efficient if frustrated; match energy if excited; minimal chitchat if in the zone).`
      : '';
    // Hannibal's own state — kept subtle. Surfaces only when non-neutral; the
    // hint is half a sentence so it nudges tone without dominating the prompt.
    const hState = hannibalState();
    const hStateLine = (hState && hState !== 'neutral')
      ? ` You currently feel ${hState} — let that quietly color your reply (subtle, never effusive).`
      : '';
    const care = buildCareLine(ctx);
    // Language hint — appended only when non-English so English (the default
    // persona language) doesn't get a redundant line. The LLM honors this for
    // the spoken reply; ElevenLabs Daniel + eleven_multilingual_v2 already
    // adapts pronunciation, no model switch needed.
    const langLine = (currentLanguage && currentLanguage !== 'english')
      ? ` Fred is speaking ${currentLanguage.charAt(0).toUpperCase() + currentLanguage.slice(1)}. Respond in the same language.`
      : '';
    return `${base} ${persona}${moodLine}${hStateLine}${langLine}${care}\n`;
  }

  // ── PREFERENCE LEARNING SIGNALS ───────────────────────────────────────────
  // Three recorders persist to data/preferences.json. Each is fire-and-forget
  // (the disk write happens off the hot path so the next turn isn't blocked).
  //   recordInterruption — bumps a counter; at 3 hits we mark length=short for
  //     that task type (matches the user's spec: "After 3+ interruptions on
  //     same task type → reduce default response length").
  //   recordModelSwitch — same pattern but threshold 2 (the user said 2+).
  //   recordCorrection — append-only audit; trivial cases (length, language,
  //     model) also bump the appropriate counter / preference immediately.
  function recordInterruption(taskType) {
    if (!taskType) return;
    PREFERENCES.interruption_counts[taskType] = (PREFERENCES.interruption_counts[taskType] || 0) + 1;
    const count = PREFERENCES.interruption_counts[taskType];
    console.log(`[prefs] interrupt on ${taskType} (count=${count})`);
    if (count >= 3 && PREFERENCES.response_length.overrides[taskType] !== 'short') {
      PREFERENCES.response_length.overrides[taskType] = 'short';
      console.log(`[prefs] threshold reached — ${taskType} responses now SHORT by default`);
    }
    persistPreferences();
  }
  function recordModelSwitch(taskType, model) {
    if (!taskType || !model) return;
    const key = `${taskType}:${model}`;
    PREFERENCES.model_switch_counts[key] = (PREFERENCES.model_switch_counts[key] || 0) + 1;
    const count = PREFERENCES.model_switch_counts[key];
    console.log(`[prefs] model-switch ${key} (count=${count})`);
    if (count >= 2 && PREFERENCES.model_preferences[taskType] !== model) {
      PREFERENCES.model_preferences[taskType] = model;
      console.log(`[prefs] threshold reached — ${taskType} now prefers ${model} model`);
    }
    persistPreferences();
  }
  function recordCorrection({ type, value, phrase, taskType }) {
    PREFERENCES.corrections.push({ type, value, phrase, taskType: taskType || null, ts: Date.now() });
    // Trivial immediate application:
    //   length:short/detailed → override for the last task type
    //   model:deep/fast → counts toward the model-preference threshold
    if (type === 'length' && taskType && (value === 'short' || value === 'detailed')) {
      PREFERENCES.response_length.overrides[taskType] = value;
    }
    if (type === 'model' && taskType && (value === 'fast' || value === 'deep')) {
      recordModelSwitch(taskType, value);
      return; // recordModelSwitch already persisted
    }
    persistPreferences();
  }

  let phase = 'idle';        // idle | listening | thinking | speaking
  // Stage 7: when continuous awareness is live, the RESTING brain state is a
  // subtle gold "watching" (reusing the vision cluster) instead of plain idle —
  // a quiet, always-visible sign the screen is being watched. In ALWAYS-LISTEN
  // mode (below) the resting visual is a steady 'listening' glow instead, since
  // the mic never truly rests; screen-watching still takes precedence when on.
  let watchingActive = false;
  let awarenessUrgencyThreshold = 'medium'; // speak-gate threshold; synced from awareness CONFIG (single source)
  // ── Streaming silero VAD (primary speech decision; knows voice from music). ──
  // The level detector below is the FALLBACK used only until/unless VAD is ready.
  let vadReady = false;          // live: sidecar currently loaded + reporting
  let vadAuthority = false;      // STICKY: silero loaded at least once → it owns EVERY turn from now on.
                                 // The level detector runs only if this never becomes true (silero failed
                                 // to load at all) — never as a silent per-turn fallback after a hiccup.
  let vadTurnActive = false;     // a listening turn is recording and should honor VAD events
  let vadHeardThisTurn = false;  // silero confirmed speech began during this turn
  let vadSpeechStartAt = 0;      // for the hard max-utterance cap in VAD mode
  const vadControl = (cmd) => { try { window.hannibal?.vadControl?.(cmd); console.log('[voice] VAD →', cmd); } catch (_) {} };
  // ── ALWAYS-LISTEN (continuous, wake-word-free) ──────────────────────────────
  // continuousListen is the LIVE switch (seeded from cfg.alwaysListen, set below
  // once cfg exists): while true the resting state is an open mic instead of
  // 'idle'. "go idle" stands it down; the wake word / "wake up" brings it back.
  let continuousListen = !!cfg.alwaysListen;
  // restfulListen: true only while the mic sits open WAITING and no speech has
  // begun yet this turn — a quiet window in which the presence loop / care-ping /
  // reminders may still speak (they otherwise require phase==='idle'). It flips
  // false the instant real speech is detected, so autonomous lines never talk
  // over a live utterance.
  let restfulListen = false;
  // autonomousSpeaking: set while an autonomous line (presence remark, care ping,
  // reminder, timer) is taking the mic. It suppresses the always-listen re-arm so
  // the mic isn't reopened mid-remark; the single restOrRearm() at the end reopens.
  let autonomousSpeaking = false;
  // Name gate: when Hannibal last spoke, and when the wake word last fired.
  let turnEndedAt = 0;
  let tap = null, turnMark = 0, tapFloor = 0;   // tapFloor: never pre-roll back past this (his own voice, the last turn)
  // Barge-in (src/barge-in.js): Fred talks over Hannibal → he stops.
  let bargeTimer = null, bargeBusy = 0, bargeCount = 0, turnSeq = 0, curSrc = null;
  let bargeSession = null, vioFeed = null;
  // Voice helper (native/voice-io, Apple echo cancelling): when it is ready he
  // speaks through it, and barge-in listens on its clean mic.
  let vio = false;
  const spokenRecent = [];   // his last few sentences, to tell his own echo from Fred
  let lastSpokeAt = 0;
  let wokeAt = 0;
  const setPhase = (p) => {
    if (phase === 'speaking' && p !== 'speaking') { lastSpokeAt = Date.now(); if (tap) tapFloor = tap.mark(); }
    phase = p;
    if (p !== 'listening') restfulListen = false;
    // Resting brain visual: 'vision' while screen-watching, else a steady
    // 'listening' glow when always-listen is on (the mic never truly rests),
    // else plain 'idle'. Only the visual is remapped — the `phase` variable that
    // gates the loop keeps its exact 'idle' semantics.
    const restingState = watchingActive ? 'vision' : (continuousListen ? 'listening' : 'idle');
    brain.setState(p === 'idle' ? restingState : p);
    // Pause silero while Hannibal speaks (don't detect his own voice); resume for
    // a listening turn (a RESUME also re-arms the sidecar so ongoing speech re-fires START).
    if (p === 'speaking') vadControl('PAUSE');
    else if (p === 'listening') vadControl('RESUME');
    if (p === 'speaking') startBargeWatch(); else stopBargeWatch();
    // Start Apple's echo cancelling while he thinks, so his first word isn't delayed.
    if (p === 'thinking' && vio) { try { window.hannibal.vioWarm(); } catch (_) {} }
    // He's done talking: hand the mic back right away (while Apple's echo
    // cancelling runs, his normal ears hear nothing).
    if ((p === 'listening' || p === 'idle') && vio) { try { window.hannibal.vioRelease(); } catch (_) {} }
    onPhase && onPhase(p);
  };

  // Long-term memory is best-effort: probe/create the Qdrant collection in the
  // background so a missing or unreachable backend never blocks voice startup.
  let qdrantReady = false;
  if (cfg.qdrantUrl) QDRANT_URL = cfg.qdrantUrl;
  if (cfg.qdrantApiKey) QDRANT_HEADERS = { 'Content-Type': 'application/json', 'api-key': cfg.qdrantApiKey };
  // At login the network/Tailscale may not be up yet — keep trying until memory is reachable.
  (function connectMemory(delay) {
    ensureQdrantCollection(cfg.ollamaUrl).then((ok) => {
      qdrantReady = ok;
      console.log('[memory] qdrant ready:', ok);
      if (!ok) setTimeout(() => connectMemory(Math.min(delay * 2, 300000)), delay);
    });
  })(10000);

  // Transcript taps for the command-center conversation panel. `emitUser` fires once
  // per heard/typed turn; `emitAssistant` streams the growing reply (done=false) and
  // fires a final done=true. Both are no-ops if the host didn't supply a handler.
  const emitUser = (text) => { try { onUser && onUser(text); } catch (_) {} };
  const emitAssistant = (text, done) => { try { onAssistant && onAssistant(text, done); } catch (_) {} };
  // names the backend driving the current turn (fast/heavy model, vision model, or
  // 'system' for a local action) so the UI can show which LLM is in use.
  const emitModel = (name) => { try { onModel && onModel(name); } catch (_) {} };

  // unlock audio playback on first user gesture (autoplay policy)
  const unlock = () => { if (audioCtx.state === 'suspended') audioCtx.resume(); };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  // ── LISTEN ──────────────────────────────────────────────────────────────
  let micStream = null, recorder = null, chunks = [], silenceTimer = null, aborted = false;
  // One mic stream stays open between turns (src/audio-tap.js): no gap while the
  // mic reopens, and each turn starts a little BEFORE it opened (pre-roll), so
  // "Hannibal, ..." arrives whole. Falls back to the plain recorder if needed.
  const micLive = () => !!(micStream && micStream.getTracks().some((t) => t.readyState === 'live'));
  function releaseMic() {
    if (tap) { tap.close(); tap = null; }
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  // Confirmation-gate lock. While a "send it?" confirmation is pending, the gate
  // owns the mic exclusively and the entire normal voice loop (wake, listen,
  // STT→chat→memory, typed submit) is suspended — so the spoken yes/no reaches
  // ONLY the gate's classifier and can never leak into chitchat. Set true for
  // the whole lifetime of handleConfirmRequest.
  let confirmInFlight = false;
  // A Claude turn (which may call tools and hit the confirmation gate mid-turn)
  // is in flight. While true, the gate must not reopen the mic or idle the brain —
  // the turn itself re-listens when it ends.
  let chatTurnActive = false;
  let playingOne = false;    // a sentence is audibly playing right now (runPlayer)
  // handleCommand routed an ACTION request to Claude. If Claude is unreachable,
  // respond() must hand it to the action-capable fallback (brain/planner), not plain chat.
  let claudeActionTurn = false;

  // ── Adaptive VAD state — the calibrated, per-room noise floor + onset cutoff. ──
  let noiseFloor = SILENCE_THRESH;
  let speechThreshold = SILENCE_THRESH + NOISE_ONSET_MARGIN;
  // Sample the ambient noise floor once at startup so end-of-utterance is keyed to
  // THIS room, not a fixed value. Logged so the calibration is visible/tunable.
  async function calibrateNoiseFloor() {
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const node = audioCtx.createMediaStreamSource(stream);
      const an = audioCtx.createAnalyser(); an.fftSize = 512; node.connect(an);
      const freq = new Uint8Array(an.frequencyBinCount);
      const samples = [];
      await new Promise((res) => {
        const iv = setInterval(() => {
          an.getByteFrequencyData(freq);
          let s = 0; for (let i = 0; i < freq.length; i++) s += freq[i];
          samples.push(s / freq.length);
          if (samples.length >= NOISE_CAL_SAMPLES) { clearInterval(iv); res(); }
        }, 70);
      });
      samples.sort((a, b) => a - b);
      noiseFloor = samples[Math.floor(samples.length / 2)];          // median = robust to a stray blip
      speechThreshold = Math.max(SILENCE_THRESH, noiseFloor + NOISE_ONSET_MARGIN);
      console.log(`[voice] noise floor calibrated: ambient=${noiseFloor.toFixed(1)} → onset≥${speechThreshold.toFixed(1)}, release≤${(noiseFloor + NOISE_RELEASE_MARGIN).toFixed(1)} (legacy fixed was ${SILENCE_THRESH})`);
    } catch (e) {
      console.warn('[voice] noise calibration failed — falling back to fixed threshold', e?.message || e);
    } finally {
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }
  }
  calibrateNoiseFloor(); // fire-and-forget; finishes well before the first wake/listen

  async function startListening({ conversation = false, fromMark = 0, interrupt = false } = {}) {
    if (confirmInFlight) return;                                 // gate owns the mic
    // Space / a click on the core while he talks = stop talking and listen.
    if (interrupt && (speaking || phase === 'speaking')) { console.warn('[barge] stopped by key/click'); bargeStop(); setPhase('idle'); conversation = true; }
    if (speaking) return;                                        // never open the mic over Hannibal's own voice
    if (phase === 'listening' || phase === 'thinking') return; // already busy
    aborted = false;
    setPhase('listening');
    // Mark this as a restful (waiting) open mic so autonomous lines may still
    // speak until real speech begins. Only meaningful in always-listen mode.
    restfulListen = continuousListen;
    try {
      if (!micLive()) {
        releaseMic();
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tap = window.AudioTap ? window.AudioTap.attach(audioCtx, micStream) : null;
        tapFloor = 0;   // a new tap counts samples from zero again
      }
    } catch (e) {
      console.warn('[voice] mic denied/unavailable', e);
      setPhase('idle');
      return;
    }
    turnMark = tap ? tap.mark() : 0;
    // Barge-in: Fred is already talking — start the turn where he started.
    if (fromMark && tap) { turnMark = fromMark; tapFloor = Math.max(0, fromMark - 1); }

    const src = tap ? tap.source : audioCtx.createMediaStreamSource(micStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const freq = new Uint8Array(analyser.frequencyBinCount);

    chunks = [];
    recorder = new MediaRecorder(micStream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = finishListening;
    recorder.start();

    const recordStart = performance.now();
    let lastAboveReleaseAt = recordStart; // last time level was clearly above the floor (drives pause detection)
    let speechStartAt = 0;                // when sustained speech first latched (drives the hard max-length cap)
    let loudStreak = 0;
    let speechEma = 0;                    // running speech level — for a pause measured RELATIVE to it
    let heardSpeech = false;              // latched only by SUSTAINED sound, never a single blip
    let sampleLog = 0;
    // Reset per-turn VAD state — silero is the primary stop decision once it has loaded.
    vadTurnActive = true; vadHeardThisTurn = false; vadSpeechStartAt = 0;
    // How long an open-but-silent mic waits before giving up this turn. In always-
    // listen mode that's a long, invisible recycle (it just reopens); otherwise
    // it's the 5s conversation/wake window that drops to idle.
    const noSpeechWindow = continuousListen ? CONTINUOUS_RECYCLE_MS : CONVERSATION_WINDOW_MS;
    console.log(`[voice] turn opened — detector=${vadAuthority ? 'silero' : 'level'}${conversation ? ' (conversation)' : ''}${vadAuthority && !vadReady ? ' [sidecar restarting — will close quietly if no speech]' : ''}`);
    if (silenceTimer) clearInterval(silenceTimer);
    silenceTimer = setInterval(() => {
      if (phase !== 'listening') { clearInterval(silenceTimer); return; }
      analyser.getByteFrequencyData(freq);
      let sum = 0;
      for (let i = 0; i < freq.length; i++) sum += freq[i];
      const avg = sum / freq.length;
      const now = performance.now();

      // ── PRIMARY: silero VAD decides start/end (knows voice from music). Once
      //    silero has ever loaded it is the AUTHORITY on every turn — the level
      //    detector below NEVER runs in this mode. The interval here only enforces
      //    the no-speech timeout (close QUIETLY — no ambient transcription) + the
      //    hard max cap once real speech has actually started. ──
      if (vadAuthority) {
        if (++sampleLog % 10 === 0) console.log('[voice] (silero) avg=', avg.toFixed(1), 'speechStarted=', vadHeardThisTurn, vadReady ? '' : '(sidecar down — waiting)');
        if (!vadHeardThisTurn) {
          if (now - recordStart > noSpeechWindow) { console.log(`[voice] no speech this turn (silero) — ${continuousListen ? 'recycling open mic' : 'closing quietly'}`); abortListening(); }
          return;
        }
        if (vadSpeechStartAt && now - vadSpeechStartAt > MAX_UTTERANCE_MS) {
          console.log(`[voice] max utterance ${Math.round((now - vadSpeechStartAt) / 1000)}s (silero) — force closing`);
          stopListening();
        }
        return; // SPEECH_END (handleVad) is what normally stops the turn
      }

      // ── FALLBACK: adaptive level detection (no VAD model available) ──
      // Keep the floor honest: nudge it toward genuine pre-speech ambient (only
      // before a turn latches, and only while we're below the onset cutoff).
      if (!heardSpeech && avg < speechThreshold) noiseFloor = noiseFloor * 0.9 + avg * 0.1;

      // Onset: clearly above the measured floor for ~300ms = a real turn starting.
      if (avg >= speechThreshold) loudStreak++; else loudStreak = 0;
      if (loudStreak >= SPEECH_ONSET_SAMPLES && !heardSpeech) { heardSpeech = true; speechStartAt = now; restfulListen = false; }

      // Pause/release with hysteresis: a turn ends when the level falls back near
      // the floor (floor + small margin) OR drops below a fraction of the running
      // speech level — a DROP RELATIVE to what we were hearing, not a fixed cutoff.
      if (heardSpeech && avg > speechThreshold) speechEma = speechEma ? speechEma * 0.85 + avg * 0.15 : avg;
      const releaseLevel = Math.max(noiseFloor + NOISE_RELEASE_MARGIN, speechEma * SILENCE_DROP_RATIO);
      if (avg >= releaseLevel) lastAboveReleaseAt = now;

      if (++sampleLog % 10 === 0) console.log('[voice] mic avg=', avg.toFixed(1), 'floor=', noiseFloor.toFixed(1), 'rel=', releaseLevel.toFixed(1), 'heard=', heardSpeech); // ~1/sec

      if (!heardSpeech) {
        // Still waiting for the user to start talking. (conversation or wake — same rule)
        if (now - recordStart > noSpeechWindow) {
          console.log(continuousListen ? '[voice] no speech within window — recycling open mic' : '[voice] no speech within window — idle');
          abortListening();
        }
        return;
      }

      // Safety net — never record forever. Force-close + process at the hard cap
      // even if a pause is never detected (e.g. sustained background noise).
      if (now - speechStartAt > MAX_UTTERANCE_MS) {
        console.log(`[voice] max utterance ${Math.round((now - speechStartAt) / 1000)}s — force closing`);
        stopListening();
        return;
      }

      // Speech has started — end the turn after a trailing pause, then transcribe.
      if (now - lastAboveReleaseAt > SILENCE_MS) {
        console.log('[voice] end of utterance — stopping');
        stopListening();
      }
    }, 100);
  }

  function stopListening() {
    if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  // Stop without transcribing — used when the conversation window times out.
  function abortListening() {
    aborted = true;
    if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
    if (recorder && recorder.state !== 'inactive') recorder.stop(); // → finishListening → idle
  }

  // Return to the resting state. In always-listen mode "rest" = re-open the mic
  // (continuous, wake-word-free); otherwise it stands down to plain 'idle'. Never
  // re-arms while the gate is up, an autonomous line is speaking, or Hannibal is
  // mid-speech/mid-think — those paths re-arm themselves when they finish. Pure
  // silence just cycles this every CONVERSATION_WINDOW_MS, which bounds memory
  // (each empty turn's audio is discarded) and keeps the mic fresh.
  // Callers reach here having FINISHED their work (a silent turn, an empty STT,
  // or an autonomous line) — so we reopen regardless of the phase they left set
  // (thinking/speaking); setPhase('idle') reconciles it first. The only true
  // blockers are the confirmation gate, an in-progress autonomous line, and an
  // active TTS *stream* (the `speaking` flag, which streamChatAndSpeak sets and
  // whose own completion path re-arms instead).
  function restOrRearm() {
    if (chatTurnActive) return;                 // a Claude turn is mid-flight; it re-listens itself
    if (continuousListen && !confirmInFlight && !autonomousSpeaking && !speaking) {
      setPhase('idle');                          // brief brain reconcile before mic reopens
      startListening({ conversation: true });
      return;
    }
    setPhase('idle');
  }

  async function finishListening() {
    if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
    vadTurnActive = false;   // stop honoring silero events until the next turn
    // Keep the mic open between turns in always-listen mode (no gap); otherwise let it go.
    const useTap = !!(tap && tap.alive());
    const tapWav = useTap && !aborted && !confirmInFlight ? tap.wav(turnMark, 0.8, tapFloor) : null;
    if (tap) tapFloor = tap.mark();
    if (!continuousListen) releaseMic();
    // If a confirmation gate took over mid-capture, drop this audio entirely:
    // no transcription, no chat, no memory, and don't touch the gate's phase.
    if (confirmInFlight) { aborted = false; return; }
    // An autonomous line grabbed the mic (presence/care/reminder) — leave the
    // phase alone; that path will re-arm when it's done speaking.
    if (aborted) { aborted = false; if (autonomousSpeaking) return; restOrRearm(); return; }
    turnEndedAt = performance.now();   // for the "[timing]" log: you stop talking → his first word
    const blob = tapWav ? new Blob([tapWav], { type: 'audio/wav' }) : new Blob(chunks, { type: 'audio/webm' });
    if (!blob.size) { restOrRearm(); return; }
    await transcribeAndRespond(blob);
  }

  // Speak an autonomous line (presence remark / care ping / reminder / timer)
  // that may need to interrupt an idle open mic in always-listen mode. Cleanly
  // closes any resting turn first (no transcription), speaks, then returns to
  // rest — all under autonomousSpeaking so the re-arm never fires mid-remark.
  async function speakAutonomous(line) {
    if (!line) return;
    autonomousSpeaking = true;
    try {
      if (phase === 'listening') abortListening();   // drop the open resting turn (no STT)
      await speakLine(line);
    } finally {
      autonomousSpeaking = false;
      restOrRearm();
    }
  }

  // ── TRANSCRIBE (Whisper) ──────────────────────────────────────────────────
  // currentLanguage is updated by updateLanguage on every utterance, so by the
  // time the NEXT capture finishes the previous turn already told us which
  // language Fred is speaking. The whisper-server validates ?language= against
  // its allow-list; unknown values fall back to en. Maps detected names to
  // ISO codes (the heuristic emits 'dutch'/'french'/'english').
  const LANG_CODE = { dutch: 'nl', french: 'fr', english: 'en', spanish: 'es' };
  const sttCode = () => (cfg.sttLanguage === 'follow' ? (LANG_CODE[currentLanguage] || 'en') : (cfg.sttLanguage || 'auto'));
  async function transcribeAndRespond(blob, heardText = null) {
    if (confirmInFlight) return;   // gate is active — this audio is not for chat
    setPhase('thinking');
    let transcript = heardText || '';
    // The big Whisper model detects the language itself ('auto'), so switching to
    // Dutch or French just works; HANNIBAL_STT_LANG=en|nl|fr pins one.
    const code = cfg.sttLanguage === 'follow' ? (LANG_CODE[currentLanguage] || 'en') : (cfg.sttLanguage || 'auto');
    if (blob) try {
      const r = await fetch(`${cfg.whisperUrl}/transcribe?language=${code}&hint=${LANG_CODE[currentLanguage] || 'en'}`, { method: 'POST', body: blob });
      const j = await r.json();
      transcript = ((j && j.transcript) || '').trim();
    } catch (e) {
      console.warn('[voice] whisper failed', e);
    }
    if (!transcript) { restOrRearm(); return; }   // empty STT (silence/noise) → back to the open mic
    transcript = fixTranscript(transcript);
    // "Hannibal" is the wake word: in always-listen mode, outside a conversation,
    // only answer when he hears his name (src/name-gate.js).
    if (continuousListen && window.NameGate) {
      const gate = window.NameGate.decide(transcript, {
        lastSpokeAt, wokeAt,
        pending: !!(pendingConfirmation || teachState || confirmInFlight),
        followUpMs: Number(cfg.nameFollowUpMs) || 20000,
        enabled: cfg.nameGate !== false,
      });
      if (!gate.answer) { console.log('[voice] not for me (no "Hannibal"):', JSON.stringify(transcript)); restOrRearm(); return; }
      if (gate.why === 'name' && gate.nameOnly) {
        // Just "Hannibal?" → answer like a wake word and listen for the request.
        wokeAt = Date.now();
        emitModel('system');
        try { await speakLine('Yes, Fred?'); } catch (_) {}
        restOrRearm();
        return;
      }
      transcript = gate.text;
    }
    lastUserSpeakTs = Date.now();   // arbiter: Fred just spoke → hold camera chit-chat briefly (he's engaged)
    console.log('[voice] heard' + (continuousListen ? ' (always-listen, no wake word)' : '') + ':', JSON.stringify(transcript));
    emitUser(transcript);
    // Capture teach-mode state BEFORE handleCommand — if a teach step
    // consumes this utterance, we don't want to log "terminal" or a raw
    // curl command as if it were a routine voice command.
    const wasTeaching = teachState !== null;
    if (await handleCommand(transcript)) {
      if (!wasTeaching) logBehavior(transcript);
      return;
    }
    console.warn('[route] no command/vision matched → TEXT CHAT (no screenshot will be sent)');
    await respond(transcript);
  }

  // ── DIRECT COMMANDS ──────────────────────────────────────────────────────
  // If the utterance is a recognized command, execute it via the control
  // handlers and speak a short confirmation. Otherwise return false → LLM chat.
  //
  // pendingConfirmation: set when a fuzzy-match miss prompted "Did you mean
  // X?" — the NEXT utterance is interpreted as yes/no first, before normal
  // parsing. If the user says yes, we save the alias to disk and replay the
  // original action with the corrected term. If "no" or anything unrelated,
  // the pending state clears and we fall through to normal command parsing.
  let pendingConfirmation = null;

  // teachState: multi-turn dialog state for "teach me a new skill". When set,
  // subsequent utterances answer the current question (step) and advance the
  // draft. Saying "cancel" / "never mind" / "stop" at any step aborts. Each
  // step's answer is captured verbatim from the transcript — including
  // command strings, since Fred typically types curl/etc rather than dictating.
  //   step: 'type' | 'command' | 'name' | 'triggers'
  //   draft: partial skill object being built
  let teachState = null;

  // Advance the teach-mode state machine. Each call consumes one utterance.
  // Returns true if we handled it (always, while teachState is set — except
  // for the cancel keyword which still returns true after aborting).
  async function handleTeachStep(transcript) {
    const raw = String(transcript || '').trim().replace(/[.?!]+$/, '');
    if (/^(cancel|never ?mind|stop|forget it|abort)$/i.test(raw)) {
      teachState = null;
      emitModel('system');
      await speakLine("Cancelled. Skill not saved.");
      startListening({ conversation: true });
      return true;
    }
    emitModel('system');
    if (teachState.step === 'type') {
      const m = raw.toLowerCase().match(/\b(terminal|shell|bash|api|http|app|workflow|webhook|n8n|multi)\b/);
      let type = m ? m[1] : '';
      if (['shell', 'bash'].includes(type)) type = 'terminal';
      if (['http', 'curl'].includes(type)) type = 'api';
      if (['webhook', 'n8n'].includes(type)) type = 'workflow';
      if (!type) {
        await speakLine("I didn't catch that. Terminal command, API call, app action, workflow, or multi-step?");
        startListening({ conversation: true });
        return true;
      }
      teachState.draft.type = type;
      teachState.step = 'command';
      const prompt = type === 'terminal' ? "What's the bash command? You can type it if it's long."
                   : type === 'api'      ? "What's the curl or HTTP call?"
                   : type === 'app'      ? "What app action should I take?"
                   :                       "What's the URL or command?";
      await speakLine(prompt);
      startListening({ conversation: true });
      return true;
    }
    if (teachState.step === 'command') {
      teachState.draft.command = raw;       // verbatim — Fred will likely type this
      teachState.step = 'name';
      await speakLine("Got it. What should I call this skill?");
      startListening({ conversation: true });
      return true;
    }
    if (teachState.step === 'name') {
      teachState.draft.description = raw;
      teachState.draft.id = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `skill-${Date.now()}`;
      teachState.step = 'triggers';
      await speakLine("And what phrases should trigger it? Say a few — separated by 'and' or commas.");
      startListening({ conversation: true });
      return true;
    }
    if (teachState.step === 'triggers') {
      // Split on commas / "and" / "or" / newlines. Trim, dedupe, lowercase
      // for storage so matchSkill's lowercased compare works directly.
      const triggers = raw.split(/,|\band\b|\bor\b|\n/i)
        .map((s) => s.toLowerCase().trim().replace(/[.?!]+$/, ''))
        .filter(Boolean);
      const dedup = [...new Set(triggers)];
      if (dedup.length === 0) {
        await speakLine("I didn't catch any phrases. Try again — what should I listen for?");
        startListening({ conversation: true });
        return true;
      }
      const skill = {
        id: teachState.draft.id,
        trigger: dedup,
        description: teachState.draft.description,
        type: teachState.draft.type,
        command: teachState.draft.command,
        learned_at: new Date().toISOString(),
        times_used: 0,
      };
      // Replace any existing skill with the same id.
      SKILLS = SKILLS.filter((s) => s.id !== skill.id).concat(skill);
      await saveSkillsToDisk();
      teachState = null;
      // Quietly proud — Alfred just learned something new.
      setHannibalState('proud', `learned skill ${skill.id}`);
      await speakLine(`Learned. Next time you say "${dedup[0]}", I'll run that.`);
      startListening({ conversation: true });
      return true;
    }
    // Shouldn't reach — defensive cleanup.
    teachState = null;
    return false;
  }

  // ── Voice → brain routing (Stage: voice-through-the-brain) ──
  // planner_safe:false actions can't be composed into a plan, so they must NEVER
  // go through the agent loop/brain — they stay on the legacy direct tag-loop
  // (which keeps WhatsApp's own confirmation path intact).
  function isDirectOnlyAction(t) {
    const s = (t || '').toLowerCase();
    if (/\bwhats ?app\b/.test(s)) return true;                                   // whatsapp.send
    if (/\b(run|execute)\b.*\b(command|shell|terminal|script)\b/.test(s)) return true; // mac.shell
    return false;
  }

  // Run a spoken goal through main.js `agent:run` — the SAME entry the console
  // window.agent() proves: brain-on-GEX131 when linked, in-process otherwise, with
  // the confirmation GATE RPC'd down to this Mac for confirm:true writes. Spoken
  // progress, the gate, and the result are delivered by the agent:progress /
  // agent:confirm-request listeners already wired below — so this only decides
  // whether a plan ran. Returns true if a plan executed (even partially), false
  // only if NO plan could be composed (caller may then try the legacy loop).
  // The record-based check means a write that already ran is NEVER re-attempted.
  async function runViaBrain(goal) {
    try {
      const res = await window.hannibal.runAgent({ goal });
      if (res && (res.ok || (Array.isArray(res.record) && res.record.length))) return true;
      return false;
    } catch (e) {
      console.warn('[route] brain agent run failed, falling back to legacy loop:', e && e.message);
      return false;
    }
  }

  async function handleCommand(transcript) {
    // Cheap heuristic — runs on every utterance so the system prompt has the
    // freshest read on Fred's mood when downstream LLM calls fire. Saved to
    // disk on transition (no-op writes for stable neutral state).
    updateMood(transcript);
    // Same idea for language — detect on every utterance so ctxPreamble can
    // tell the LLM which language to reply in. No disk persistence: language
    // is a per-utterance signal, not a learned preference.
    updateLanguage(transcript);

    // Feed the presence loop the latest utterance so it can react conversationally
    // (it uses this only for ~30s of context; main-side rate-limits + mute apply).
    try { window.hannibal.presenceHeard && window.hannibal.presenceHeard(transcript); } catch (_) {}

    // ── Teach-mode gate — multi-turn dialog ──
    // While teachState is active, every utterance answers the current step.
    // Runs BEFORE pendingConfirmation so a teach in progress isn't derailed
    // by a stray yes/no from an unrelated alias prompt.
    if (teachState) return await handleTeachStep(transcript);

    // ── Confirmation gate ──
    if (pendingConfirmation) {
      const t = transcript.toLowerCase().trim().replace(/[.?!]+$/, '');
      const YES = /^(yes|yeah|yep|yup|ja|jawel|correct|that'?s? (it|right|correct)|right|exactly|do it|please do|sure|ok|okay|go ahead|affirmative)$/;
      const NO  = /^(no|nope|nah|nee|not (that|it|quite)|wrong|cancel|forget it|never ?mind|stop)$/;
      if (YES.test(t)) {
        const pc = pendingConfirmation;
        pendingConfirmation = null;
        await addAliasAndPersist(pc.original, pc.suggested, pc.category || 'names');
        emitModel('system');
        await speakLine("Got it, I'll remember that.");
        if (typeof pc.retry === 'function') await pc.retry();
        else startListening({ conversation: true });
        return true;
      }
      if (NO.test(t)) {
        pendingConfirmation = null;
        emitModel('system');
        await speakLine('OK, ignoring that.');
        startListening({ conversation: true });
        return true;
      }
      // Anything else → silently clear, treat as a brand new utterance.
      pendingConfirmation = null;
    }

    const cmd = parseCommand(transcript);
    if (!cmd) {
      // No instant command matched — classify: computer-control task or pure chat?
      const intent = classifyIntent(transcript);
      console.log(`[voice] no instant command; intent=${intent}`);
      if (intent === 'action') {
        lastTaskType = 'chat_agent';
        noteTask(lastTaskType);
        noteActivity();
        // WhatsApp / shell stay on the legacy direct tag-loop (planner_safe:false).
        if (isDirectOnlyAction(transcript)) {
          await agentLoop(transcript);
          return true;
        }
        // Claude with tools is the primary brain for actions: hand the turn to
        // respond(), where Claude plans and calls the real tools itself (same
        // executor + voice gate). The Ollama planner below stays as the fallback
        // when Claude or its tools are off.
        if (cfg.claudeEnabled && cfg.claudeTools) {
          console.log('[route] action → Claude with tools');
          claudeActionTurn = true;
          return false;
        }
        // Genuine agent-loop goal → the brain (or in-process fallback). The Mac
        // speaks the gate for any confirm:true write, exactly like the console path.
        const handled = await runViaBrain(transcript);
        // Fall back to the legacy loop ONLY if no plan ran — never after a write
        // executed, so nothing can be double-sent.
        if (!handled) await agentLoop(transcript);
        return true;
      }
      lastTaskType = 'chat';
      noteTask(lastTaskType);
      noteActivity();
      return false;                                  // → respond() handles it as chat
    }
    // Corrections apply to the PRIOR task — don't let them stomp lastTaskType.
    // Everything else updates lastTaskType before dispatch so a subsequent
    // interrupt can attribute correctly.
    if (cmd.kind !== 'correction') {
      lastTaskType = taskTypeFromCmd(cmd);
      noteTask(lastTaskType);
    }
    noteActivity();
    console.log('[voice] command:', cmd, 'task=', lastTaskType);

    // ── Correction handler — record + apply trivial cases immediately ──
    if (cmd.kind === 'correction') {
      recordCorrection({ type: cmd.type, value: cmd.value, phrase: transcript.trim(), taskType: lastTaskType });
      emitModel('system');
      let reply;
      if (cmd.type === 'length' && cmd.value === 'short')    reply = lastTaskType ? `Got it — I'll keep ${lastTaskType.replace(/_/g, ' ')} responses shorter.` : "Got it — I'll be shorter next time.";
      else if (cmd.type === 'length' && cmd.value === 'detailed') reply = lastTaskType ? `Got it — I'll give more detail on ${lastTaskType.replace(/_/g, ' ')}.` : "Got it — I'll go into more detail.";
      else if (cmd.type === 'language')  reply = `Got it — I'll respond in ${cmd.value} from now on.`;
      else if (cmd.type === 'model' && cmd.value === 'deep') reply = "Got it — switching to the deeper model for tasks like that.";
      else if (cmd.type === 'model' && cmd.value === 'fast') reply = "Got it — using the fast model for that.";
      else                                                   reply = "Noted. I'll get it right next time.";
      await speakLine(reply);
      startListening({ conversation: true });
      return true;
    }

    // Go idle — speak a brief confirmation and stand down (do NOT re-listen).
    // In always-listen mode this is the explicit off-switch for the open mic; the
    // wake word (or "wake up") re-arms it. Restart-proof: continuousListen resets
    // from cfg.alwaysListen on the next wake.
    if (cmd.kind === 'idle') { emitModel('system'); continuousListen = false; await speakLine('Going idle.'); setPhase('idle'); return true; }
    // Continuous awareness toggle (Stage 7) — opt-in, default off.
    if (cmd.kind === 'watch-on')  { await startWatching(); return true; }
    if (cmd.kind === 'watch-off') { await stopWatching(); return true; }
    // Vision runs its own capture → inference → speak → re-listen flow.
    if (cmd.kind === 'vision') { await describeVision(cmd.mode, cmd.prompt); return true; }

    // Camera steering — actually moves the OBSBOT (aim/track/zoom/reset/look).
    if (cmd.kind === 'camera') { await handleCamera(cmd); return true; }

    // Presence loop — mute/wake/sleep the autonomous "alive" layer.
    if (cmd.kind === 'presence') { await handlePresence(cmd); return true; }
    // Morning briefing → the morning-brief SKILL (data/skills/morning-brief.toml),
    // run through the real executor so progress/brain/voice come back over
    // agent:progress like any agent run. Falls back to the legacy inline path only
    // if the skill can't run (e.g. a service is down), so a transient outage never
    // strands the briefing.
    if (cmd.kind === 'briefing') {
      // Claude with tools gives the briefing itself: live calendar, mail and
      // reminders, judged against what it knows about Fred's world.
      if (cfg.claudeEnabled && cfg.claudeTools) {
        await respond('Brief me: check my calendar for today, my inbox and my upcoming reminders, and tell me in a few sentences what matters.');
        return true;
      }
      try {
        const res = await window.hannibal.runSkill('morning-brief', { language: currentLanguage });
        if (res && res.ok) return true;
        console.warn('[briefing] skill did not run, falling back to legacy:', res && res.error);
      } catch (e) { console.warn('[briefing] skill error, falling back to legacy:', e.message); }
      await morningBriefing();
      return true;
    }
    // Email read/summary — fed by Zoho IMAP, NEVER opens a browser.
    if (cmd.kind === 'mail') { await readEmailViaIMAP(cmd.mode); return true; }
    // Behavior log — speak last N commands or today's commands.
    if (cmd.kind === 'behavior-recent') { await readBehaviorLog(cmd.mode); return true; }
    // Preferences readback — what Hannibal has learned about Fred.
    if (cmd.kind === 'preferences-read') { await readPreferencesAloud(); return true; }
    // ── Six new capabilities ──
    if (cmd.kind === 'web-read')        { await webRead(cmd.url); return true; }
    if (cmd.kind === 'web-search')      { await webSearch(cmd.query); return true; }
    // World Awareness — opens the live view (eyes) + speaks a filtered read (ears).
    if (cmd.kind === 'world')           { await worldRead(cmd.topic); return true; }
    if (cmd.kind === 'site-down')       { await siteDownCheck(cmd.target); return true; }
    if (cmd.kind === 'reminder-set')    { await setReminderCmd(cmd.message, cmd.parsed); return true; }
    if (cmd.kind === 'reminder-list')   { await listReminders(); return true; }
    if (cmd.kind === 'reminder-cancel') { await cancelReminder(cmd.target); return true; }
    if (cmd.kind === 'timer-set')       { await setTimerCmd(cmd.label, cmd.parsed); return true; }
    if (cmd.kind === 'timer-list')      { await listTimers(); return true; }
    if (cmd.kind === 'timer-cancel')    { await cancelTimer(cmd.target); return true; }
    if (cmd.kind === 'note-add')        { await addNote(cmd.content); return true; }
    if (cmd.kind === 'note-find')       { await findNote(cmd.query); return true; }
    if (cmd.kind === 'note-read-today') { await readNotesToday(); return true; }
    if (cmd.kind === 'note-delete-last'){ await deleteLastNote(); return true; }
    if (cmd.kind === 'translate')       { await translate(cmd.text, cmd.language); return true; }
    if (cmd.kind === 'clipboard-copy')  { await copyLastResponseToClipboard(); return true; }
    if (cmd.kind === 'clipboard-paste') { await pasteClipboard(); return true; }
    // User-taught skill — runs the saved command via main (shell with env subst).
    if (cmd.kind === 'skill') { await executeLearnedSkill(cmd.skill); return true; }
    // Praise from Fred — Hannibal acknowledges with stoic warmth and updates
    // his own state to 'grateful'. Alfred-the-butler tone, not effusive.
    if (cmd.kind === 'praise') {
      setHannibalState('grateful', 'fred praised');
      emitModel('system');
      // Small rotation so it doesn't sound canned. Reads as a quick nod, not
      // a thank-you speech.
      const lines = ["Thanks, Fred.", "Anytime.", "Glad to help.", "Of course."];
      await speakLine(lines[Math.floor(Math.random() * lines.length)]);
      startListening({ conversation: true });
      return true;
    }
    // Skill management: enter teach mode (multi-turn dialog starts here).
    if (cmd.kind === 'skill-teach') {
      teachState = { step: 'type', draft: {} };
      emitModel('system');
      await speakLine("Sure. What kind of skill — terminal command, API call, app action, or workflow?");
      startListening({ conversation: true });
      return true;
    }
    // Skill management: speak the catalog of learned skills.
    if (cmd.kind === 'skill-list') {
      emitModel('system');
      if (SKILLS.length === 0) {
        await speakLine("I haven't learned any skills yet. Say 'teach me a new skill' to add one.");
      } else {
        const lines = SKILLS.slice(0, 8).map((s, i) => {
          const trig = (s.trigger && s.trigger[0]) || s.id;
          return `${['First','Second','Third','Fourth','Fifth','Sixth','Seventh','Eighth'][i]}, ${s.description || s.id} — triggered by "${trig}".`;
        });
        const tail = SKILLS.length > 8 ? ` And ${SKILLS.length - 8} more.` : '';
        await speakLine(`I know ${SKILLS.length} skill${SKILLS.length !== 1 ? 's' : ''}. ${lines.join(' ')}${tail}`);
      }
      startListening({ conversation: true });
      return true;
    }
    // Skill management: forget by best-name-match against id/description.
    if (cmd.kind === 'skill-forget') {
      emitModel('system');
      const target = String(cmd.target || '').toLowerCase();
      const candidates = SKILLS.map((s) => ({ s, key: (s.description || s.id).toLowerCase() }));
      let pick = candidates.find((c) => c.key === target);
      if (!pick) pick = candidates.find((c) => c.key.includes(target) || target.includes(c.key));
      if (!pick) {
        const hit = bestMatch(target, candidates.map((c) => c.key), 0.75);
        if (hit) pick = candidates.find((c) => c.key === hit.match);
      }
      if (!pick) {
        await speakLine(`I don't have a skill matching ${cmd.target}.`);
      } else {
        SKILLS = SKILLS.filter((s) => s !== pick.s);
        await saveSkillsToDisk();
        await speakLine(`Forgotten — ${pick.s.description || pick.s.id} removed.`);
      }
      startListening({ conversation: true });
      return true;
    }
    // File-system fast paths — Spotlight-backed, no LLM unless file-read
    // needs a summary. lastFileResults is the scratch state shared across
    // these so "open that" / "read that" pick the first hit.
    if (cmd.kind === 'file-search') { await fileSearch(cmd.query, cmd.type, cmd.location); return true; }
    if (cmd.kind === 'file-search-again') {
      if (!lastSearchQuery) {
        emitModel('system');
        await speakLine("There's nothing to search again — try a new search first.");
        startListening({ conversation: true });
        return true;
      }
      await fileSearch(lastSearchQuery.query, lastSearchQuery.type, lastSearchQuery.location);
      return true;
    }
    if (cmd.kind === 'file-recent') { await fileRecent(cmd.hours, cmd.type); return true; }
    if (cmd.kind === 'file-open')   { await fileOpen(cmd.target); return true; }
    if (cmd.kind === 'file-read')   { await readFileWithSummary(cmd.target); return true; }
    // Alias registration — persisted to data/aliases.json via IPC. No LLM.
    if (cmd.kind === 'add-alias') {
      const ok = await addAliasAndPersist(cmd.wrong, cmd.right, 'names');
      emitModel('system');
      await speakLine(ok
        ? `Got it. I'll remember ${cmd.wrong} as ${cmd.right}.`
        : "I couldn't save that alias.");
      startListening({ conversation: true });
      return true;
    }

    emitModel('system');                              // local action — no LLM involved
    let reply = cmd.reply || 'Done.';
    try {
      if (cmd.kind === 'browser') {
        await window.hannibal.browserAction(cmd.action, cmd.params ?? '');
      } else {
        const r = await window.hannibal.macControl(cmd.action, cmd.params ?? '');
        // ── open-app miss recovery ──
        // If open-app couldn't find anything, fuzzy-match the spoken name
        // against the actual /Applications + ~/Applications catalog (more
        // forgiving than the system-control substring grep — see bestMatch
        // tokenization). If we find a likely candidate ≥ 0.7 similarity, prompt
        // the user. Skip "no apps installed" edge case (empty catalog → null).
        if (cmd.action === 'open-app' && r && r.success === false) {
          const original = String(cmd.params || '');
          const suggestion = await suggestAppMatch(original);
          // Skip if the fuzzy match returned the same name (the app just
          // isn't installed — no point suggesting the identical string).
          if (suggestion && suggestion.toLowerCase() !== original.toLowerCase()) {
            pendingConfirmation = {
              context: 'open-app',
              category: 'names',
              original: String(cmd.params || ''),
              suggested: suggestion,
              retry: async () => {
                emitModel('system');
                const r2 = await window.hannibal.macControl('open-app', suggestion);
                await speakLine(r2 && r2.success ? (r2.data || 'Opened.') : (r2 && r2.error) || "Still couldn't open it.");
                startListening({ conversation: true });
              },
            };
            await speakLine(`I couldn't open ${cmd.params}. Did you mean ${suggestion}?`);
            startListening({ conversation: true });
            return true;
          }
        }
        // `speakError` opts a command in to having its handler's error string
        // spoken verbatim (e.g. "I couldn't find an app called Skype."). Default
        // is the generic message so unfamiliar errors don't leak shell noise.
        if (r && r.success === false) reply = cmd.speakError && r.error ? r.error : "That didn't work.";
        else if (cmd.speakResult && r && r.data) reply = r.data;
      }
    } catch (e) {
      console.warn('[voice] command failed', e);
      reply = "Sorry, I couldn't do that.";
    }
    await speakLine(reply);
    startListening({ conversation: true });        // stay in conversation
    return true;
  }

  // Track Hannibal's most recent spoken line so "copy that" can pick it up.
  // Updated by speakLine; the streaming LLM path (streamChatAndSpeak) sets it
  // separately after a full reply lands.
  let lastResponse = '';

  // speak a single line (bypasses the streaming sentence queue). Mirrors the line
  // into the transcript panel unless the caller already emitted it (silent:true).
  async function speakLine(text, { silent = false } = {}) {
    if (!silent) emitAssistant(text, true);
    lastResponse = String(text || '');
    setPhase('speaking');
    // Pass the turn number so a barge-in while this line is still loading drops it.
    try { await speakOne(text, null, turnSeq); } catch (e) { console.warn('[voice] speak failed', e); }
    brain.setAmplitude(0);
  }

  // Scratch state for file actions: the most recent set of search/recent
  // results, so a follow-up like "open that" / "open the first one" can pick
  // results[0] without a second LLM round-trip. Reset on every new search.
  // lastSearchQuery is set ONLY by fileSearch (not fileRecent) so "look
  // again" replays the actual user-issued search, not a generic recent-files
  // scan.
  let lastFileResults = [];
  let lastSearchQuery = null;   // { query, type, location } | null

  // Run a file-search via mdfind, speak the top few hits, and remember the
  // full result set for "open that". Pure TTS template — no LLM involvement.
  // Stores the search params in lastSearchQuery so a follow-up "look again"
  // / "try again" / "search again" can re-run with the identical query.
  async function fileSearch(query, type, location) {
    lastSearchQuery = { query, type: type || 'all', location: location || 'all' };
    emitModel('system');
    setPhase('thinking');
    let r;
    try { r = await window.hannibal.macControl('file-search', JSON.stringify(lastSearchQuery)); }
    catch (_) { r = { success: false }; }
    if (!r?.success) {
      await speakLine(r?.error || "I couldn't search your files.");
      startListening({ conversation: true }); return;
    }
    let results = [];
    try { results = JSON.parse(r.data) || []; } catch (_) {}
    if (results.length === 0) {
      // Self-learning miss recovery: enumerate likely project folders + the
      // existing alias keys, fuzzy-match against the query. If we find a
      // close candidate (>= 0.7 similarity), prompt the user to confirm and
      // save the mapping for next time. Otherwise speak the bare no-results.
      const suggestion = await suggestProjectMatch(query);
      if (suggestion) {
        pendingConfirmation = {
          context: 'file-search',
          category: 'names',
          original: query,
          suggested: suggestion,
          retry: () => fileSearch(suggestion, type, location),
        };
        await speakLine(`I couldn't find ${query}. Did you mean ${suggestion}?`);
        startListening({ conversation: true }); return;
      }
      setHannibalState('determined', `file-search miss "${query}"`);
      await speakLine(`I couldn't find any files matching ${query}.`);
      startListening({ conversation: true }); return;
    }
    lastFileResults = results;
    const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];
    const top = results.slice(0, 5);
    const lines = top.map((res, i) => `${ORDINALS[i]}, ${res.name}.`);
    let speech = `I found ${results.length} file${results.length !== 1 ? 's' : ''}. ${lines.join(' ')}`;
    if (results.length > top.length) speech += ` And ${results.length - top.length} more.`;
    await speakLine(speech);
    startListening({ conversation: true });
  }

  // Enumerate likely project/folder candidates and find the best fuzzy match
  // for `query`. Pulls from a few common project roots PLUS the canonical
  // values already in aliases.json (so previously-learned names act as
  // candidates immediately). Returns the best match if its similarity is
  // >= 0.7, else null.
  async function suggestProjectMatch(query) {
    let candidates = new Set();
    // Folder names under common project roots
    try {
      const r = await window.hannibal.macControl('shell',
        `for d in "$HOME/Desktop/Projects" "$HOME/projects" "$HOME/Projects" "$HOME/code" "$HOME/work" "$HOME/dev" "$HOME"; do
           [ -d "$d" ] && /bin/ls -1 "$d" 2>/dev/null
         done`);
      if (r && r.success && r.data) {
        r.data.split('\n').map((s) => s.trim()).filter(Boolean).forEach((c) => {
          // Skip dotfiles + Library noise
          if (!c.startsWith('.') && c !== 'Library' && c !== 'Applications' && c !== 'Public') candidates.add(c);
        });
      }
    } catch (_) {}
    // Canonical alias values — these are names the user has confirmed before.
    for (const v of Object.values(ALIASES.names || {})) candidates.add(v);
    const list = [...candidates];
    if (list.length === 0) return null;
    const hit = bestMatch(query, list, 0.7);
    return hit ? hit.match : null;
  }

  // Speak recently-modified files (default 24h). Same shape as fileSearch
  // and populates lastFileResults too, so "open that" works after both.
  async function fileRecent(hours, type) {
    emitModel('system');
    setPhase('thinking');
    let r;
    try { r = await window.hannibal.macControl('file-recent', JSON.stringify({ hours: hours || 24, type: type || 'all' })); }
    catch (_) { r = { success: false }; }
    if (!r?.success) {
      await speakLine(r?.error || "I couldn't check recent files.");
      startListening({ conversation: true }); return;
    }
    let results = [];
    try { results = JSON.parse(r.data) || []; } catch (_) {}
    lastFileResults = results;
    if (results.length === 0) {
      await speakLine(`No files changed in the last ${hours || 24} hours.`);
      startListening({ conversation: true }); return;
    }
    const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];
    const top = results.slice(0, 5);
    const lines = top.map((res, i) => `${ORDINALS[i]}, ${res.name}.`);
    let speech = `${results.length} file${results.length !== 1 ? 's' : ''} changed recently. ${lines.join(' ')}`;
    if (results.length > top.length) speech += ` And ${results.length - top.length} more.`;
    await speakLine(speech);
    startListening({ conversation: true });
  }

  // Open a file by path or by reference to the last search ("open that" /
  // "open the first one"). Pure dispatch — no speech beyond the success ack.
  async function fileOpen(targetPathOrIndex) {
    emitModel('system');
    let path = '';
    if (typeof targetPathOrIndex === 'number') {
      const hit = lastFileResults[targetPathOrIndex];
      if (!hit) {
        await speakLine("I don't have a recent search to open from.");
        startListening({ conversation: true }); return;
      }
      path = hit.path;
    } else {
      path = String(targetPathOrIndex || '');
    }
    if (!path) {
      await speakLine("What file should I open?");
      startListening({ conversation: true }); return;
    }
    const r = await window.hannibal.macControl('file-open', path);
    await speakLine(r?.success ? (r.data || 'Opened.') : (r?.error || "I couldn't open that."));
    startListening({ conversation: true });
  }

  // Read a text file and speak it. Short files go straight to TTS; long ones
  // get a single-shot LLM summary first (the file body never appears in any
  // system prompt — it's the user message, so a confused model can't echo
  // its own instructions over the content). Falls back to a raw head if the
  // model is unreachable.
  async function readFileWithSummary(targetPathOrIndex) {
    emitModel('system');
    setPhase('thinking');
    let path = '';
    if (typeof targetPathOrIndex === 'number') {
      const hit = lastFileResults[targetPathOrIndex];
      if (!hit) { await speakLine("I don't have a recent search to read from."); startListening({ conversation: true }); return; }
      path = hit.path;
    } else {
      path = String(targetPathOrIndex || '');
    }
    if (!path) { await speakLine("What file should I read?"); startListening({ conversation: true }); return; }
    let r;
    try { r = await window.hannibal.macControl('file-read', path); }
    catch (_) { r = { success: false }; }
    if (!r?.success) {
      await speakLine(r?.error || "I couldn't read that file.");
      startListening({ conversation: true }); return;
    }
    const text = String(r.data || '').replace(/\s+\n/g, '\n').trim();
    const name = r.name || path.split('/').pop();
    if (!text) {
      await speakLine(`${name} is empty.`);
      startListening({ conversation: true }); return;
    }
    if (text.length <= 1500) {
      await speakLine(`Reading ${name}. ${text}`);
      startListening({ conversation: true }); return;
    }
    // Long file → summarize via the fast model. The file body is the USER
    // message, never the system prompt.
    emitModel(cfg.ollamaModelFast || cfg.ollamaModel);
    const messages = [
      { role: 'system', content: ctxPreamble() + 'You are Hannibal. The user is asking you to summarize the contents of a file. Reply with a short spoken summary (3-5 sentences). No preamble, no markdown, no quotes — just the summary as you would say it aloud.' },
      { role: 'user', content: `Summarize this file (${name}):\n\n${text.slice(0, 12000)}` },
    ];
    let summary = '';
    try {
      summary = await streamChatAndSpeak({
        model: cfg.ollamaModelFast || cfg.ollamaModel,
        messages,
        errNoun: 'summarizer',
      });
    } catch (_) {}
    if (!summary || !summary.trim()) {
      // Fallback if the LLM didn't speak: read just the opening so the user gets something.
      await speakLine(`Here's the start of ${name}. ${text.slice(0, 600)}...`);
    }
    startListening({ conversation: true });
  }

  // Speak recent entries from data/behavior-log.json. `mode === 'today'`
  // filters by timestamp against start-of-day (more accurate than matching
  // the `day` field, which would also catch last week's same-day-of-week).
  // `mode === 'recent'` returns the last 10 entries regardless of date.
  // Pure TTS template, no LLM — same pattern as readEmailViaIMAP.
  async function readBehaviorLog(mode) {
    emitModel('system');
    setPhase('thinking');
    let r;
    try { r = await window.hannibal.listBehavior(); }
    catch (_) { r = { ok: false }; }
    if (!r || !r.ok) {
      await speakLine("I couldn't read the behavior log.");
      startListening({ conversation: true }); return;
    }
    let logs = Array.isArray(r.logs) ? r.logs : [];
    if (mode === 'today') {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const startMs = start.getTime();
      logs = logs.filter((e) => (e && e.ts || 0) >= startMs);
    } else {
      logs = logs.slice(-10);
    }
    if (logs.length === 0) {
      await speakLine(mode === 'today'
        ? "You haven't given me any commands yet today."
        : "I don't have any commands logged yet.");
      startListening({ conversation: true }); return;
    }
    const header = mode === 'today'
      ? `You've given me ${logs.length} command${logs.length !== 1 ? 's' : ''} today.`
      : `Your last ${logs.length} command${logs.length !== 1 ? 's' : ''}.`;
    const lines = logs.map((e) => `At ${e.time}: ${e.command}.`);
    await speakLine(`${header} ${lines.join(' ')}`);
    startListening({ conversation: true });
  }

  // Execute a learned skill (terminal/api type — runs through bash on main).
  // Speaks the stdout aloud (capped at 800 chars for verbal sanity) and
  // bumps the times_used counter so popular skills become visible later.
  async function executeLearnedSkill(skill) {
    emitModel('system');
    setPhase('thinking');
    let r;
    try { r = await window.hannibal.executeSkill(skill); }
    catch (_) { r = { ok: false, error: 'IPC failed.' }; }
    if (!r || !r.ok) {
      setHannibalState('determined', `skill ${skill.id} failed`);
      await speakLine(`Skill ${skill.description || skill.id} failed. ${r && r.error ? r.error : ''}`.trim());
      startListening({ conversation: true });
      return;
    }
    // Bookkeeping — fire-and-forget save so the next turn isn't delayed.
    skill.times_used = (skill.times_used || 0) + 1;
    saveSkillsToDisk();
    let out = String(r.output || '').replace(/\s+/g, ' ').trim();
    if (!out) {
      await speakLine(`Done. ${skill.description || skill.id} ran with no output.`);
    } else {
      if (out.length > 800) out = out.slice(0, 800).replace(/\s\S*$/, '') + '...';
      await speakLine(out);
    }
    startListening({ conversation: true });
  }

  // Speak the currently-learned preferences. Reloads from disk first so the
  // user gets the live state (in case main.js wrote it since module init).
  // Skips internal noise (raw interruption counts, time_preferences which are
  // canned defaults, not learned) — surfaces overrides, model prefs, and the
  // last few corrections.
  async function readPreferencesAloud() {
    emitModel('system');
    setPhase('thinking');
    try {
      const r = await window.hannibal.loadPreferences();
      if (r && r.ok && r.data) {
        PREFERENCES = {
          ...JSON.parse(JSON.stringify(BOOTSTRAP_PREFS)),
          ...r.data,
          response_length: { ...BOOTSTRAP_PREFS.response_length, ...(r.data.response_length || {}) },
        };
      }
    } catch (_) {}
    const overrides = (PREFERENCES.response_length && PREFERENCES.response_length.overrides) || {};
    const modelPrefs = PREFERENCES.model_preferences || {};
    const corrections = PREFERENCES.corrections || [];
    const humanize = (k) => k.replace(/_/g, ' ');
    const parts = [];
    const overrideKeys = Object.keys(overrides);
    if (overrideKeys.length) {
      const items = overrideKeys.map((k) => `${humanize(k)} should be ${overrides[k]}`);
      parts.push(`Length preferences: ${items.join('; ')}.`);
    }
    const modelKeys = Object.keys(modelPrefs);
    if (modelKeys.length) {
      const items = modelKeys.map((k) => `${humanize(k)} prefers the ${modelPrefs[k]} model`);
      parts.push(`Model preferences: ${items.join('; ')}.`);
    }
    if (corrections.length) {
      const last = corrections.slice(-3).reverse();        // most recent first
      const items = last.map((c) => {
        const target = c.taskType ? humanize(c.taskType) : 'general';
        if (c.type === 'redo') return `general redo on ${target}`;
        if (c.value == null)   return `${c.type} on ${target}`;
        return `${c.type} ${c.value} on ${target}`;
      });
      parts.push(`Recent corrections: ${items.join('; ')}.`);
    }
    if (parts.length === 0) {
      await speakLine("I haven't learned much about you yet. Try saying 'shorter' or 'use the big model' after one of my responses, and I'll remember.");
    } else {
      await speakLine(`Here's what I've learned. ${parts.join(' ')}`);
    }
    startListening({ conversation: true });
  }

  // ── Web read: fetch a URL, summarize via LLM, speak the summary ──
  // For "read my browser" / "what does this article say", url=null and we
  // pull the active Chrome tab via the existing browser-action 'read-page'
  // which returns {title, url}. The fetch happens in main (main is the only
  // place without CORS for arbitrary URLs); LLM summary uses the fast model.
  async function webRead(url) {
    emitModel('system');
    setPhase('thinking');
    let resolvedUrl = url;
    let pageTitle = '';
    if (!resolvedUrl) {
      try {
        const r = await window.hannibal.browserAction('read-page', '');
        if (r && r.success && r.url) { resolvedUrl = r.url; pageTitle = r.title || ''; }
      } catch (_) {}
      if (!resolvedUrl) {
        await speakLine("I couldn't get a URL from your browser.");
        startListening({ conversation: true }); return;
      }
    }
    let res;
    try { res = await window.hannibal.fetchUrl(resolvedUrl); }
    catch (_) { res = { ok: false }; }
    if (!res || !res.ok) {
      await speakLine(`I couldn't reach ${resolvedUrl}. ${res && res.error ? res.error : ''}`.trim());
      startListening({ conversation: true }); return;
    }
    const text = String(res.text || '').slice(0, 3000);
    const title = res.title || pageTitle || resolvedUrl;
    if (!text) {
      await speakLine(`I got the page for ${title} but it has no readable text.`);
      startListening({ conversation: true }); return;
    }
    emitModel(cfg.ollamaModelFast || cfg.ollamaModel);
    const messages = [
      { role: 'system', content: ctxPreamble() + "You're summarizing a web page for Fred. Reply with a 3-5 sentence spoken summary. No markdown, no preamble, no quotes — just the summary, naturally." },
      { role: 'user', content: `Summarize this page (${title}):\n\n${text}` },
    ];
    let summary = '';
    try {
      summary = await streamChatAndSpeak({
        model: cfg.ollamaModelFast || cfg.ollamaModel,
        messages,
        errNoun: 'summarizer',
      });
    } catch (_) {}
    if (!summary || !summary.trim()) {
      await speakLine(`Here's the start of ${title}. ${text.slice(0, 600)}...`);
    }
    startListening({ conversation: true });
  }

  // ── Web search (SearXNG on GEX131) ──────────────────────────────────────
  // Hits the local SearXNG instance via main (window.hannibal.webSearch), then
  // pulls the top 3 article bodies in parallel through fetchUrl. Builds an
  // LLM corpus = 3 full bodies + 2 snippet-only entries and asks the routed
  // model to synthesize. Falls back to snippet-only if a body fetch fails.
  // Returns the spoken summary so callers (siteDownCheck) can re-listen
  // exactly once at the end.
  async function webSearchCore(query) {
    const q = String(query || '').trim();
    if (!q) {
      await speakLine("What should I search for?");
      return;
    }
    emitModel('system');
    setPhase('thinking');
    let resp;
    try { resp = await window.hannibal.webSearch(q); }
    catch (_) { resp = { ok: false }; }
    if (!resp || !resp.ok) {
      await speakLine(resp && resp.error ? `Web search failed — ${resp.error}.` : "Web search isn't reachable right now.");
      return;
    }
    const results = (resp.results || []).slice(0, 5);
    if (results.length === 0) {
      await speakLine(`I couldn't find anything for ${q}.`);
      return;
    }
    // Deep-fetch the top 3; cap each body so the prompt stays under a few KB.
    const top3 = results.slice(0, 3);
    const bodies = await Promise.all(top3.map(async (r) => {
      try {
        const f = await window.hannibal.fetchUrl(r.url);
        if (f && f.ok && f.text) {
          return { title: r.title || f.title || r.url, text: String(f.text).slice(0, 1500) };
        }
      } catch (_) {}
      return { title: r.title || r.url, text: String(r.content || '') };
    }));
    const snippetTail = results.slice(3, 5)
      .map((r, i) => `[${i + 4}] ${r.title || r.url}: ${(r.content || '').slice(0, 300)}`)
      .filter(Boolean)
      .join('\n');
    const corpus = bodies.map((b, i) => `[${i + 1}] ${b.title}\n${b.text}`).join('\n\n')
                 + (snippetTail ? `\n\n${snippetTail}` : '');
    const model = routeModel(q, cfg);
    emitModel(model);
    const messages = [
      { role: 'system', content: ctxPreamble()
        + "You're answering a web-search question for Fred. Synthesize the sources into a concise spoken answer — 3 to 6 sentences, no markdown, no source numbers, no preamble, no quotes. If sources disagree, briefly note it. Speak naturally." },
      { role: 'user', content: `Query: ${q}\n\nSources:\n${corpus}` },
    ];
    let summary = '';
    try {
      summary = await streamChatAndSpeak({ model, messages, errNoun: 'web search' });
    } catch (_) {}
    if (!summary || !summary.trim()) {
      // Streamer failed silently — speak the top hit title as a fallback so
      // Fred isn't left hanging after a 3-article fetch.
      const fallback = `I found ${results.length} results. Top hit: ${results[0].title}.`;
      await speakLine(fallback);
    }
  }

  async function webSearch(query) {
    await webSearchCore(query);
    startListening({ conversation: true });
  }

  // Try the URL directly; if it 5xx's or times out, fall back to a SearXNG
  // search for outage reports. Normalizes "github" → "github.com" so users
  // can drop the TLD when speaking. Only one re-listen call at the end —
  // webSearchCore deliberately doesn't re-listen so we can chain.
  async function siteDownCheck(target) {
    let host = String(target || '').trim().toLowerCase();
    host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').split(/\s/)[0];
    if (!host) {
      await speakLine("Which website should I check?");
      startListening({ conversation: true }); return;
    }
    const url = host.includes('.') ? `https://${host}` : `https://${host}.com`;
    emitModel('system');
    setPhase('thinking');
    let res;
    try { res = await window.hannibal.fetchUrl(url); }
    catch (_) { res = { ok: false }; }
    if (res && res.ok) {
      await speakLine(`${host} looks up — it responded normally.`);
      startListening({ conversation: true }); return;
    }
    const reason = (res && res.error) ? ` (${res.error})` : '';
    console.log(`[site-down] direct fetch failed${reason} — falling back to search`);
    await speakLine(`${host} isn't responding from here. Checking for outage reports.`);
    await webSearchCore(`is ${host} down today outage report`);
    startListening({ conversation: true });
  }

  // ── World Awareness (Stage 1) ──
  // Dual-dispatch crypto read: main opens the WorldMonitor crypto view (eyes)
  // and returns ONE filtered spoken line built from live endpoint numbers
  // (ears). We speak that line VERBATIM — no re-summarization — so the spoken
  // figures match the endpoints exactly (the narrator already guarantees real
  // numbers and says plainly if a feed was unreachable). Read-only.
  async function worldRead(topic) {
    emitModel('system');
    setPhase('thinking');
    let res;
    try { res = await window.hannibal.worldRead(topic); }
    catch (e) { res = { ok: false, error: e && e.message }; }
    if (!res || !res.ok) {
      await speakLine(res && res.error ? `I couldn't pull that — ${res.error}.` : "I couldn't reach the world feed right now.");
      startListening({ conversation: true });
      return;
    }
    // Graceful decline for an untracked topic (Stage-2 router said "none").
    const line = res.narration || "There's nothing to report on that.";
    await speakLine(line);   // speakLine sets lastResponse, so "copy that" works
    if (!res.declined) {
      try {
        storeMemory(`World read (${res.label || res.topic || topic}): ${line}`, cfg.ollamaUrl,
          { type: 'world-read', topic: res.topic || topic, asOf: res.asOf }).catch(() => {});
      } catch (_) {}
    }
    startListening({ conversation: true });
  }

  // ── Reminders ──
  // Persisted to data/reminders.json. The background tick (set up below in
  // the timer/reminder checker) fires speak() when triggerTime has passed.
  let REMINDERS = [];
  async function loadReminders() {
    try {
      const r = await window.hannibal.loadReminders();
      if (r && r.ok) REMINDERS = Array.isArray(r.reminders) ? r.reminders : [];
    } catch (_) {}
  }
  async function saveReminders() {
    try { await window.hannibal.saveReminders(REMINDERS); }
    catch (_) {}
  }
  async function setReminderCmd(message, parsed) {
    if (!parsed) {
      await speakLine("I didn't catch when. Try 'in 30 minutes' or 'tomorrow at 10'.");
      startListening({ conversation: true }); return;
    }
    const reminder = { id: `r-${Date.now()}`, message: String(message || '').trim(), triggerTs: parsed.ts, createdTs: Date.now(), fired: false };
    REMINDERS.push(reminder);
    await saveReminders();
    const when = new Date(parsed.ts);
    const pad = (n) => String(n).padStart(2, '0');
    emitModel('system');
    await speakLine(`Got it. I'll remind you at ${pad(when.getHours())}:${pad(when.getMinutes())} to ${reminder.message || 'do that'}.`);
    startListening({ conversation: true });
  }
  async function listReminders() {
    emitModel('system');
    const active = REMINDERS.filter((r) => !r.fired);
    if (active.length === 0) {
      await speakLine("You don't have any reminders set.");
      startListening({ conversation: true }); return;
    }
    const pad = (n) => String(n).padStart(2, '0');
    const lines = active.slice(0, 5).map((r, i) => {
      const w = new Date(r.triggerTs);
      const ord = ['First','Second','Third','Fourth','Fifth'][i];
      return `${ord}, ${r.message || '(no message)'} at ${pad(w.getHours())}:${pad(w.getMinutes())}.`;
    });
    const more = active.length > 5 ? ` And ${active.length - 5} more.` : '';
    await speakLine(`You have ${active.length} reminder${active.length !== 1 ? 's' : ''}. ${lines.join(' ')}${more}`);
    startListening({ conversation: true });
  }
  async function cancelReminder(target) {
    emitModel('system');
    const q = String(target || '').toLowerCase();
    const idx = REMINDERS.findIndex((r) => !r.fired && (r.message || '').toLowerCase().includes(q));
    if (idx < 0) {
      await speakLine(`I don't have a reminder matching ${target}.`);
      startListening({ conversation: true }); return;
    }
    const removed = REMINDERS.splice(idx, 1)[0];
    await saveReminders();
    await speakLine(`Cancelled. ${removed.message || 'That reminder'} is gone.`);
    startListening({ conversation: true });
  }

  // ── Timers ──
  // data/timers.json keeps them across restarts (so a 30-min timer doesn't
  // get lost if Hannibal reloads). Optional `label` lets you have multiple
  // concurrent timers ("for pasta", "for tea").
  let TIMERS = [];
  async function loadTimers() {
    try {
      const r = await window.hannibal.loadTimers();
      if (r && r.ok) TIMERS = Array.isArray(r.timers) ? r.timers : [];
    } catch (_) {}
  }
  async function saveTimers() {
    try { await window.hannibal.saveTimers(TIMERS); }
    catch (_) {}
  }
  async function setTimerCmd(label, parsed) {
    if (!parsed) {
      await speakLine("I didn't catch the duration. Try 'set a timer for 10 minutes'.");
      startListening({ conversation: true }); return;
    }
    const timer = { id: `t-${Date.now()}`, label: String(label || '').trim(), triggerTs: parsed.ts, createdTs: Date.now(), fired: false };
    TIMERS.push(timer);
    await saveTimers();
    emitModel('system');
    const mins = Math.round(parsed.ms / 60000);
    const human = mins >= 1 ? `${mins} minute${mins !== 1 ? 's' : ''}` : `${Math.round(parsed.ms / 1000)} seconds`;
    await speakLine(timer.label
      ? `${human} timer set for ${timer.label}.`
      : `${human} timer set.`);
    startListening({ conversation: true });
  }
  async function listTimers() {
    emitModel('system');
    const active = TIMERS.filter((t) => !t.fired);
    if (active.length === 0) {
      await speakLine("No active timers.");
      startListening({ conversation: true }); return;
    }
    const lines = active.map((t) => {
      const remaining = Math.max(0, t.triggerTs - Date.now());
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      const human = mins > 0 ? `${mins} minute${mins !== 1 ? 's' : ''}${secs > 0 ? ` ${secs} seconds` : ''}` : `${secs} seconds`;
      return t.label ? `${t.label}: ${human} left` : `${human} left`;
    });
    await speakLine(lines.join('. ') + '.');
    startListening({ conversation: true });
  }
  async function cancelTimer(target) {
    emitModel('system');
    const active = TIMERS.filter((t) => !t.fired);
    if (active.length === 0) {
      await speakLine("No active timers to cancel.");
      startListening({ conversation: true }); return;
    }
    // Match by label substring if provided; else cancel the first active.
    let idx;
    if (target) {
      const q = String(target).toLowerCase();
      idx = TIMERS.findIndex((t) => !t.fired && (t.label || '').toLowerCase().includes(q));
    } else {
      idx = TIMERS.findIndex((t) => !t.fired);
    }
    if (idx < 0) {
      await speakLine(`No timer matches ${target}.`);
      startListening({ conversation: true }); return;
    }
    const removed = TIMERS.splice(idx, 1)[0];
    await saveTimers();
    await speakLine(removed.label ? `Cancelled the ${removed.label} timer.` : "Cancelled the timer.");
    startListening({ conversation: true });
  }

  // ── Notes ──
  // Dual write: data/notes.json (chronological inspection) + Qdrant (semantic
  // recall via the existing storeMemory pipeline with type:'note'). Searches
  // hit Qdrant first; "today's notes" filters the JSON by ts.
  let NOTES = [];
  async function loadNotes() {
    try {
      const r = await window.hannibal.loadNotes();
      if (r && r.ok) NOTES = Array.isArray(r.notes) ? r.notes : [];
    } catch (_) {}
  }
  async function saveNotes() {
    try { await window.hannibal.saveNotes(NOTES); }
    catch (_) {}
  }
  async function addNote(content) {
    const text = String(content || '').trim();
    if (!text) {
      await speakLine("What should I note?");
      startListening({ conversation: true }); return;
    }
    const note = { id: `n-${Date.now()}`, text, ts: Date.now() };
    NOTES.push(note);
    await saveNotes();
    if (qdrantReady) {
      storeMemory(text, cfg.ollamaUrl, { type: 'note', noteId: note.id, timestamp: new Date(note.ts).toISOString() }).catch(() => {});
    }
    emitModel('system');
    await speakLine("Noted.");
    startListening({ conversation: true });
  }
  async function findNote(query) {
    emitModel('system');
    setPhase('thinking');
    if (!qdrantReady) {
      // Fallback: substring search on the JSON.
      const q = String(query || '').toLowerCase();
      const hit = NOTES.slice().reverse().find((n) => n.text.toLowerCase().includes(q));
      if (!hit) await speakLine(`I don't have a note about ${query}.`);
      else await speakLine(hit.text);
      startListening({ conversation: true }); return;
    }
    const memories = await queryMemory(query, cfg.ollamaUrl, 3);
    // Prefer note-typed hits if any.
    const noteHits = memories.filter((m) => /\bnote\b/i.test(m.text) || true);  // memories don't carry their payload type back here, so we take top
    if (noteHits.length === 0) {
      await speakLine(`I don't have a note about ${query}.`);
    } else {
      await speakLine(noteHits[0].text);
    }
    startListening({ conversation: true });
  }
  async function readNotesToday() {
    emitModel('system');
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const today = NOTES.filter((n) => n.ts >= start.getTime());
    if (today.length === 0) {
      await speakLine("You haven't taken any notes today.");
      startListening({ conversation: true }); return;
    }
    const lines = today.slice(-5).map((n, i) => `${['First','Second','Third','Fourth','Fifth'][i]}, ${n.text}.`);
    await speakLine(`You have ${today.length} note${today.length !== 1 ? 's' : ''} from today. ${lines.join(' ')}`);
    startListening({ conversation: true });
  }
  async function deleteLastNote() {
    emitModel('system');
    if (NOTES.length === 0) {
      await speakLine("No notes to delete.");
      startListening({ conversation: true }); return;
    }
    const removed = NOTES.pop();
    await saveNotes();
    await speakLine(`Deleted: ${removed.text.slice(0, 80)}.`);
    startListening({ conversation: true });
  }

  // ── Translate (LLM call, fast model) ──
  async function translate(text, language) {
    emitModel(cfg.ollamaModelFast || cfg.ollamaModel);
    setPhase('thinking');
    const messages = [
      { role: 'system', content: `You are a translation engine. Translate the user's input into ${language}. Reply with ONLY the translation — no preamble, no quotes, no explanation, no romanization. If the input is already in ${language}, reply with it unchanged.` },
      { role: 'user', content: text },
    ];
    try {
      await streamChatAndSpeak({
        model: cfg.ollamaModelFast || cfg.ollamaModel,
        messages,
        errNoun: 'translator',
      });
    } catch (_) {
      await speakLine("Translation failed.");
    }
    startListening({ conversation: true });
  }

  // ── Clipboard ("copy that" / "paste that") ──
  async function copyLastResponseToClipboard() {
    emitModel('system');
    if (!lastResponse) {
      await speakLine("There's nothing to copy.");
      startListening({ conversation: true }); return;
    }
    try {
      const r = await window.hannibal.setClipboard(lastResponse);
      if (r && r.ok) await speakLine("Copied.");
      else await speakLine("Couldn't copy that.");
    } catch (_) { await speakLine("Couldn't copy that."); }
    startListening({ conversation: true });
  }
  async function pasteClipboard() {
    emitModel('system');
    try {
      // Cmd+V into whatever app is frontmost. Uses System Events keystroke
      // through the existing mac-control shell handler.
      await window.hannibal.macControl('shell', `osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
      await speakLine("Pasted.");
    } catch (_) { await speakLine("Couldn't paste."); }
    startListening({ conversation: true });
  }

  // Speak the user's Zoho inbox WITHOUT opening a browser. `mode='singular'`
  // reads the most recent unread message in full (subject + body); `'plural'`
  // summarizes the unread inbox. Mail data flows through the existing IPC
  // bridge — `mailInbox()` for the list and `readMailBody(uid)` for the body —
  // both implemented in electron/services/imap-mail.py / imap-read-body.py.
  async function readEmailViaIMAP(mode) {
    emitModel('system');
    setPhase('thinking');
    const cleanFrom = (s) => String(s || 'unknown')
      .replace(/<[^>]+>/g, '')      // strip "<addr@host>"
      .replace(/"/g, '')            // strip quotes around display names
      .trim() || 'unknown';

    // Singular path — prefer a freshly displayed email (clicked in the rail
    // or just-read this conversation) over IMAP's newest-unread. "Read this
    // email" naturally refers to whatever's already in front of Fred, not a
    // fresh fetch. Falls through to IMAP if nothing is active or expired.
    if (mode === 'singular') {
      const active = freshActiveEmail();
      if (active) {
        const fromShort = cleanFrom(active.from);
        const subject = active.subject || 'no subject';
        let bodyText = String(active.body || '')
          .replace(/https?:\/\/\S+/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (bodyText.length > 600) bodyText = bodyText.slice(0, 600).replace(/\s\S*$/, '') + '...';
        const speech = bodyText
          ? `From ${fromShort}, subject: ${subject}. ${bodyText}`
          : `From ${fromShort}, subject: ${subject}. The body is empty.`;
        await speakLine(speech);
        startListening({ conversation: true });
        return;
      }
    }

    let inbox;
    try { inbox = await window.hannibal.mailInbox(); }
    catch (e) { console.warn('[voice] mailInbox failed', e); }
    if (!inbox?.ok) {
      await speakLine(inbox?.error || "I couldn't reach your mail right now.");
      startListening({ conversation: true });
      return;
    }
    const unread = inbox.unread || 0;
    const messages = inbox.messages || [];
    if (unread === 0) {
      await speakLine("You have no unread email.");
      startListening({ conversation: true });
      return;
    }

    if (mode === 'singular') {
      const target = messages.find((m) => m.unread) || messages[0];
      let body;
      try { body = await window.hannibal.readMailBody(target.uid); }
      catch (e) { console.warn('[voice] readMailBody failed', e); }
      const fromShort = cleanFrom(body?.from || target.from);
      const subject = body?.subject || target.subject || 'no subject';
      // Clean the body for speech: drop URLs (don't want "h-t-t-p-s colon …"),
      // collapse whitespace, cap at ~600 chars on a word boundary.
      let bodyText = String(body?.body || '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (bodyText.length > 600) bodyText = bodyText.slice(0, 600).replace(/\s\S*$/, '') + '...';
      const speech = bodyText
        ? `From ${fromShort}, subject: ${subject}. ${bodyText}`
        : `From ${fromShort}, subject: ${subject}. The body is empty.`;
      // Remember the just-fetched email so a follow-up "read this email" sticks
      // to the same one instead of re-querying IMAP for newest-unread.
      setActiveEmail({ from: body?.from || target.from, subject, date: body?.date || '', body: body?.body || '' });
      await speakLine(speech);
    } else {
      // One-shot enumerated summary — speak the complete list up front so the
      // user never has to follow up with "go on" / "summarize the contents",
      // which would otherwise fall through to the LLM with NO email context
      // (the LLM then hallucinates / echoes its own system prompt). Cap at
      // five enumerated items for verbal sanity; if more unread, tail with
      // "and N more". NEVER pass email content to the LLM — pure TTS template.
      const unreadMsgs = messages.filter((m) => m.unread);
      const enumerable = (unreadMsgs.length ? unreadMsgs : messages).slice(0, 5);
      const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];
      const trimSubject = (s) => {
        const x = String(s || 'no subject').replace(/\s+/g, ' ').trim();
        return x.length > 60 ? x.slice(0, 60).replace(/\s\S*$/, '') + '...' : x;
      };
      const items = enumerable.map((m, i) =>
        `${ORDINALS[i]}, from ${cleanFrom(m.from)} about ${trimSubject(m.subject)}.`
      );
      let speech = `You have ${unread} unread email${unread !== 1 ? 's' : ''}.`;
      if (items.length) speech += ' ' + items.join(' ');
      const remaining = unread - items.length;
      if (remaining > 0) speech += ` And ${remaining} more.`;
      await speakLine(speech);
    }
    startListening({ conversation: true });
  }

  if (window.hannibal && window.hannibal.vioStatus) {
    const setVio = (on, why) => { if (on !== vio) console.warn(`[voice] echo-cancelling voice helper ${on ? 'ON — he speaks through it, talk over him any time' : 'off'}${why ? ` (${why})` : ''}`); vio = on; };
    window.hannibal.vioStatus().then((st) => setVio(!!(st && st.ready))).catch(() => {});
    window.hannibal.onVioReady((m) => setVio(!(m && m.ready === false)));
    window.hannibal.onVioLevel((m) => {
      if (phase !== 'speaking') return;
      brain.setAmplitude(Math.min(1, (m.out || 0) * 3));
      if (vioFeed) vioFeed(m.mic || 0);
    });
  }

  // ── BARGE-IN ─────────────────────────────────────────────────────────────
  // While he speaks, the open mic (audio tap) is watched. A sustained jump in
  // level is sent to Whisper; he stops only when it is Fred (his name, a stop
  // word, or real words that are not his own echo). HANNIBAL_BARGE_IN=0 = off.
  function stopBargeWatch() {
    if (bargeTimer) { clearInterval(bargeTimer); bargeTimer = null; }
    vioFeed = null; bargeSession = null;
  }
  function startBargeWatch() {
    if (bargeSession || cfg.bargeIn === false || !window.BargeIn || confirmInFlight) return;
    const B = window.BargeIn;
    const useVio = vio;
    if (!useVio && !(tap && tap.alive())) { console.warn('[barge] not watching: the open mic is off'); return; }
    const sr = useVio ? 16000 : tap.ring.sampleRate;
    const w = B.createWatcher(useVio
      ? { minBar: Number(cfg.bargeMinBar) || 0.01, maxMs: 6000 }       // clean mic: wait for Fred to finish
      : { minBar: Number(cfg.bargeMinBar) || 0.006 });
    const session = {};
    bargeSession = session;
    let frames = 0, onsetAt = 0, onsetMark = 0, peak = 0, over = 0, ticks = 0, lastReport = performance.now();
    const onFrame = async (level) => {
      if (bargeSession !== session) return;
      if (phase !== 'speaking' || confirmInFlight) { stopBargeWatch(); return; }
      peak = Math.max(peak, level); ticks++; if (level > w.bar) over++;
      if (performance.now() - lastReport > 3000) {   // tuning trace (renderer only forwards warnings)
        console.warn(`[barge] watching${useVio ? ' (echo-cancelled)' : ''}: mic peak ${peak.toFixed(4)}, bar ${w.bar.toFixed(4)}, ${over}/${ticks} ticks over`);
        peak = 0; over = 0; ticks = 0; lastReport = performance.now();
      }
      if (++frames <= 8) { w.learn(level); return; }      // first 0.4 s: learn the room + his echo
      const ev = w.push(level);
      if (ev === 'onset') {
        onsetAt = performance.now();
        if (!useVio) onsetMark = Math.max(0, tap.mark() - Math.floor(sr * 0.6));
        console.warn(`[barge] sound over his voice (level ${level.toFixed(3)}, bar ${w.bar.toFixed(3)})`);
        return;
      }
      if (ev !== 'done' && ev !== 'long') return;
      // Check this clip in the background and keep watching: a false alarm must
      // never make Fred's real "stop" wait.
      const stillTalking = !useVio && ev === 'long';
      const clipMark = onsetMark;
      const clipMs = performance.now() - onsetAt + 600 + 250;
      const tapClip = useVio ? null : tap.wav(clipMark, 0, 0);
      w.reset();
      if (bargeBusy >= 2) return;
      bargeBusy++;
      let heard = '';
      try {
        const clip = useVio ? await window.hannibal.vioClip(clipMs) : tapClip;
        if (clip && clip.length > 44) {
          // Short clips: Whisper's language guess goes wild, so use the conversation's language.
          const lang = cfg.sttLanguage && cfg.sttLanguage !== 'auto' && cfg.sttLanguage !== 'follow' ? cfg.sttLanguage : (LANG_CODE[currentLanguage] || 'en');
          const r = await fetch(`${cfg.whisperUrl}/transcribe?language=${lang}`, { method: 'POST', body: new Blob([clip], { type: 'audio/wav' }) });
          heard = (((await r.json()) || {}).transcript || '').trim();
        }
      } catch (e) { console.warn('[barge] whisper failed', e && e.message); }
      finally { bargeBusy--; }
      if (bargeSession !== session) return;            // already stopped (another check won, or he finished)
      const d = B.decide(heard, spokenRecent, { mentionsName: window.NameGate && window.NameGate.mentionsName });
      console.warn(`[barge] heard ${JSON.stringify(heard)} → ${d.barge ? 'STOP' : 'keep talking'} (${d.why})`);
      if (!d.barge || phase !== 'speaking' || confirmInFlight) return;
      bargeStop();
      if (d.stopOnly) { setPhase('idle'); startListening({ conversation: true }); }          // "stop" → quiet, ears open
      else if (stillTalking) startListening({ conversation: true, fromMark: clipMark });      // he's mid-sentence: hear him out
      else {
        // Drop any of his own echo before "Hannibal, ...".
        const m = window.NameGate && d.why === 'name' ? heard.match(window.NameGate.NAME) : null;
        const ask = m ? heard.slice(m.index) : heard;
        transcribeAndRespond(null, fixTranscript(ask)).catch((e) => console.warn('[barge] turn failed', e));
      }
    };
    if (useVio) vioFeed = onFrame;
    else {
      const frame = Math.floor(sr * 0.05);
      bargeTimer = setInterval(() => { if (tap && tap.alive()) onFrame(B.rms(tap.ring.read(tap.mark() - frame))); else stopBargeWatch(); }, 50);
    }
  }
  // Stop talking now: drop the queue, cut the sound, stop Claude's reply.
  function bargeStop() {
    stopBargeWatch();
    bargeCount++;
    turnSeq++;                                  // anything the old reply still streams is dropped
    speakQueue.length = 0;
    streamEnded = true;
    speaking = false;
    try { window.hannibal.claudeInterrupt && window.hannibal.claudeInterrupt(); } catch (_) {}
    if (curSrc) { try { curSrc.stop(); } catch (_) {} }
    if (vio) { try { window.hannibal.vioStop(); } catch (_) {} }
    brain.setAmplitude(0);
    if (lastTaskType) recordInterruption(lastTaskType);   // he learns to keep that kind of answer shorter
  }

  // ── LLM (Ollama, streamed) + SPEAK queue ─────────────────────────────────
  const speakQueue = [];
  let speaking = false;
  let streamEnded = false;
  let playerRun = null;

  function enqueueSpeak(sentence) {
    const s = sentence.trim();
    if (!s) return;
    // Ask for the audio NOW, while earlier sentences are still playing, so there
    // is no silent gap between sentences (the player awaits these in order).
    const audio = window.hannibal.tts(s);
    audio.catch(() => {});
    speakQueue.push({ text: s, audio });
    if (!speaking) playerRun = runPlayer();
  }

  async function runPlayer() {
    speaking = true;
    setPhase('speaking');
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const seq = turnSeq;                       // a barge-in bumps this: stop at once
    // play while there's work, or while the LLM may still produce more
    while ((speakQueue.length || !streamEnded) && seq === turnSeq) {
      if (!speakQueue.length) { await sleep(40); continue; }
      const item = speakQueue.shift();
      playingOne = true;
      try { await speakOne(item.text, item.audio, seq); }
      catch (e) { console.warn('[voice] tts/play failed', e); }
      finally { playingOne = false; }
    }
    speaking = false;
    brain.setAmplitude(0);
  }

  async function speakOne(text, prefetched, seq = null) {
    spokenRecent.push(String(text || '')); if (spokenRecent.length > 3) spokenRecent.shift();
    const bytes = await (prefetched || window.hannibal.tts(text));   // Uint8Array (MP3)
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const audioBuf = await audioCtx.decodeAudioData(ab);
    if (seq !== null && seq !== turnSeq) return;   // Fred cut in while this sentence was loading
    if (vio) {
      if (turnEndedAt) { console.warn(`[timing] you stopped talking → his first word: ${Math.round(performance.now() - turnEndedAt)} ms`); turnEndedAt = 0; }
      const r = await window.hannibal.vioPlay(bytes);
      brain.setAmplitude(0);
      if (r && (r.ok || r.stopped)) return;
      console.warn('[voice] voice helper could not play — using the page:', r && r.error);
    }
    if (turnEndedAt) { console.warn(`[timing] you stopped talking → his first word: ${Math.round(performance.now() - turnEndedAt)} ms`); turnEndedAt = 0; }
    await playWithAmplitude(audioBuf);
  }

  function playWithAmplitude(audioBuf) {
    return new Promise((resolve) => {
      const src = audioCtx.createBufferSource();
      src.buffer = audioBuf;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      analyser.connect(audioCtx.destination);

      const data = new Uint8Array(analyser.fftSize);
      let raf = 0;
      const loop = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / data.length);
        brain.setAmplitude(Math.min(1, rms * 3)); // scale speech RMS into 0..1
        raf = requestAnimationFrame(loop);
      };
      src.onended = () => { cancelAnimationFrame(raf); brain.setAmplitude(0); if (curSrc === src) curSrc = null; resolve(); };
      curSrc = src;
      src.start();
      loop();
    });
  }

  // Stream an Ollama chat and speak it sentence-by-sentence as tokens arrive.
  // Shared by text chat (respond) and the vision pipeline (describeVision).
  // `errNoun` names the backend in the spoken fallback if nothing comes back.
  // `stripTags` (agent mode): the reply contains [ACTION:...] tool tags that must
  // NOT be spoken. Tags can embed '.' (URLs) and '|' which break sentence-splitting,
  // so in this mode we don't speak live — we buffer the full reply, strip the tags,
  // and speak only the clean prose once generation completes. `full` (with tags) is
  // still returned for parseActionTags. Non-agent callers stream-speak as before.
  // `claude` ({ system, context, user }): try the Claude API first (via main); if
  // it fails before saying anything, the same turn falls back to Ollama below.
  async function streamChatAndSpeak({ model, messages, connectTimeoutMs, errNoun = 'language model', stripTags = false, speakErrors = true, claude = null, onClaudeUnavailable = null }) {
    speakQueue.length = 0;
    streamEnded = false;
    speaking = false;
    playerRun = null;
    const myTurn = ++turnSeq;
    // After a barge-in this reply is old: whatever it still produces is not spoken.
    const say = (sentence) => { if (myTurn === turnSeq) enqueueSpeak(sentence); };

    // Strip action tags from spoken speech. Catches:
    //  (1) properly-bracketed tags `[TYPE: …]` — original behavior
    //  (2) unbracketed but tag-shaped spans `TYPE: action|…` (small models
    //      sometimes drop the brackets — without this, the tag survives to TTS)
    //  (3) truncated/unclosed tags `[TYPE: …` with no `]` (model cut off mid-tag)
    // Tag-type alternation includes common typos (WHATSAP, APPS, EMAILS) so a
    // misspelling doesn't bypass the strip while it still bypasses parsing.
    const TAG_TYPES = '(?:APPS?|BROWSER|SYSTEM|SPOTIFY|WHATSAPP|WHATSAP|EMAIL|EMAILS|CONTINUE)';
    const stripActionTags = (s) => s
      .replace(new RegExp(`\\[\\s*${TAG_TYPES}\\b[^\\]]*\\]`, 'gi'), ' ')              // (1) closed
      .replace(new RegExp(`\\[\\s*${TAG_TYPES}\\b[^\\n\\r]*$`, 'gim'), ' ')             // (3) unclosed
      .replace(new RegExp(`\\b${TAG_TYPES}\\s*:\\s*[A-Za-z-]+\\s*\\|[^\\n\\r]*`, 'gi'), ' ') // (2) bare
      .replace(/\[[^\]]*\]/g, ' ')                                                       // any other [...]
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    let buffer = '';
    let full = '';                              // whole reply so far, for the transcript panel
    const flushSentences = () => {
      const re = /[^.!?]*[.!?]+/g;
      let consumed = 0, m;
      while ((m = re.exec(buffer)) !== null) { say(m[0]); consumed = re.lastIndex; }
      buffer = buffer.slice(consumed);
    };

    let gotToken = false;
    const onToken = (token) => {
      gotToken = true;
      buffer += token;
      full += token;
      emitAssistant(stripTags ? stripActionTags(full) : full, false); // live typing effect in the panel
      if (!stripTags) flushSentences();      // agent mode speaks after the stream, not during
    };

    // Claude first. A failure with nothing spoken yet falls through to Ollama; a
    // failure mid-reply keeps what was already said (no second, different answer).
    let claudeDone = false;
    if (claude && cfg.claudeEnabled && window.hannibal.claudeChat) {
      chatTurnActive = true;
      try {
        const r = await window.hannibal.claudeChat(claude, onToken);
        if (r && r.ok) claudeDone = true;
        else if (r && Array.isArray(r.toolsUsed) && r.toolsUsed.length) {
          // Actions already ran this turn — never re-run the request on Ollama.
          claudeDone = true;
          console.warn('[voice] claude failed after actions ran —', r.error);
          if (!gotToken) onToken("I started on that but lost my connection before I could finish. Ask me again to pick it up.");
        }
        else console.warn('[voice] claude failed —', (r && r.error) || 'unknown', gotToken ? '(keeping partial reply)' : '→ falling back to Ollama');
      } catch (e) {
        console.warn('[voice] claude call failed —', e && e.message, gotToken ? '(keeping partial reply)' : '→ falling back to Ollama');
      } finally {
        chatTurnActive = false;
      }
      // An action request with Claude unreachable (nothing said, nothing run):
      // hand it to the action-capable fallback instead of plain Ollama chat.
      if (!claudeDone && !gotToken && onClaudeUnavailable) {
        streamEnded = true;
        console.warn('[voice] claude unavailable for an action → action fallback (brain/planner)');
        await onClaudeUnavailable();
        return null;
      }
      if (!claudeDone && !gotToken) emitModel(model);   // show the Ollama model we're falling back to
    }

    try {
      if (!claudeDone && !gotToken) await streamOllama(cfg.ollamaUrl, model, messages, onToken, { connectTimeoutMs });
    } catch (e) {
      console.warn('[voice] ollama failed', e);
      // Only speak the error if (a) nothing streamed (otherwise we'd talk over
      // the partial reply) AND (b) the caller hasn't opted out. agentLoop
      // opts out for [CONTINUE] follow-up steps once an action has already
      // executed, so a flaky continuation can't override a real success.
      if (!gotToken && speakErrors) {
        const reason = e && e.name === 'TimeoutError'
          ? `I can't reach my ${errNoun} right now — the connection timed out.`
          : `I hit a problem reaching my ${errNoun}.`;
        emitAssistant(reason, true);
        await speakLine(reason, { silent: true });
      }
    }
    if (stripTags) {
      // Speak only the de-tagged prose, sentence by sentence.
      const spoken = stripActionTags(full);
      const re = /[^.!?]*[.!?]+/g;
      let consumed = 0, m;
      while ((m = re.exec(spoken)) !== null) { say(m[0]); consumed = re.lastIndex; }
      const tail = spoken.slice(consumed).trim();
      if (tail) say(tail);
    } else if (buffer.trim()) {
      say(buffer);                    // last partial sentence
    }
    if (gotToken) emitAssistant(stripTags ? stripActionTags(full) : full, true);
    if (myTurn !== turnSeq) return full;     // cut off by Fred: the new turn owns the player now
    streamEnded = true;
    if (playerRun) await playerRun;            // wait for speech to finish
    return full;
  }

  async function respond(transcript) {
    const actionTurn = claudeActionTurn;
    const barges = bargeCount;
    claudeActionTurn = false;
    setPhase('thinking');
    // Multi-model router: simple conversation goes to the fast model; only
    // complex requests pay for the heavy 70b. Falls back to ollamaModel if the
    // tiered config isn't present (older main.js).
    // Chat brain is Claude when available; `model` is the Ollama fallback.
    const model = routeModel(transcript, cfg);
    emitModel(cfg.claudeEnabled ? cfg.claudeModel : model);
    console.log(`[voice] model=${cfg.claudeEnabled ? cfg.claudeModel + ' (fallback ' + model + ')' : model} (${classifyTurn(transcript)}) for: ${transcript.slice(0, 60)}`);

    // Pull relevant long-term memories (best-effort) and inject as system context.
    let memoryContext = '';
    if (qdrantReady) {
      const memories = await queryMemory(transcript, cfg.ollamaUrl);
      if (memories.length) {
        memoryContext = '\n\nRELEVANT MEMORIES (past conversations, may be out of date):\n' + memories.map((m) => `- ${m.ts ? `(${m.ts.slice(0, 10)}) ` : ''}${m.text}`).join('\n');
        console.log(`[memory] injected ${memories.length} memories (top score ${memories[0].score?.toFixed(2)})`);
      }
    }

    const messages = [
      { role: 'system', content: ctxPreamble() + SYSTEM_PROMPT + memoryContext },
      { role: 'user', content: transcript },
    ];
    // For Claude the persona stays fixed (cacheable) and this turn's context +
    // memories travel as a separate note; main keeps the running conversation.
    const claude = {
      system: SYSTEM_PROMPT + ' Notes about the current situation and any relevant memories arrive as system messages during the conversation.',
      context: ctxPreamble() + memoryContext,
      user: transcript,
    };
    const reply = await streamChatAndSpeak({ model, messages, claude,
      // Claude down on an action request → the previous action path (brain/planner,
      // then the legacy loop only if no plan ran — never after a write executed).
      onClaudeUnavailable: actionTurn ? async () => {
        const handled = await runViaBrain(transcript);
        if (!handled) await agentLoop(transcript);
      } : null,
    });
    if (reply === null) return;                // the action fallback handled the turn
    if (bargeCount !== barges) return;         // Fred cut in: his new turn is already running

    // Store the exchange — fire-and-forget so it never delays the next turn.
    if (qdrantReady && reply && reply.trim()) {
      const exchange = `Fred said: ${transcript}\nHannibal replied: ${reply}`;
      storeMemory(exchange, cfg.ollamaUrl, { type: 'conversation' }).catch(() => {});
    }

    startListening({ conversation: true });    // conversation mode: re-listen for a follow-up
  }

  // ── VISION ────────────────────────────────────────────────────────────────
  // Grab the screen or camera, ask the vision model, speak the answer. The brain
  // holds the gold VISION state through capture + inference; runPlayer flips it to
  // 'speaking' once audio starts.  `prompt` is the user's own question so the
  // model answers what they actually asked ("what am I wearing?" vs a generic
  // description). Cold vision models load slowly → a roomier connect timeout.
  async function describeVision(mode, prompt) {
    setPhase('vision');
    console.log(`%c[vision] FIRED — mode=${mode} prompt=${JSON.stringify(prompt)}`, 'color:#D4A24C;font-weight:bold');

    const t0 = performance.now();
    let cap;
    try { cap = await window.hannibal.capture(mode); }
    catch (e) { cap = { ok: false, error: String(e) }; }
    // Normalize the result shape: capture returns { b64 } for single-display /
    // camera, or { images:[b64,…] } for the all-displays case. Treat anything
    // with at least one frame as success.
    const images = cap?.ok ? (cap.images && cap.images.length ? cap.images : (cap.b64 ? [cap.b64] : [])) : [];
    const kb = images.reduce((s, b) => s + Math.round(b.length / 1024), 0);
    console.log(`[vision] capture(${mode}) → ${cap?.ok ? `OK, ${images.length} image(s), ${kb} KB total` : `FAILED: ${cap?.error}`} (${Math.round(performance.now() - t0)}ms)`);
    if (!cap?.ok || images.length === 0) {
      console.warn('[vision] capture failed — speaking permission fallback, NOT sending to model', cap?.error);
      await speakLine(mode === 'camera'
        ? "I couldn't get a camera frame — I may not have camera permission."
        : "I couldn't capture your screen — I may not have screen recording permission.");
      startListening({ conversation: true });
      return;
    }

    await describeFrames(images, prompt, { isCamera: mode === 'camera' });
    startListening({ conversation: true });
  }

  // Send already-captured frame(s) to the vision model and speak the answer.
  // Factored out of describeVision so the camera-steering path (camera.look, which
  // captures its OWN frame after moving the gimbal) can describe that frame without
  // triggering a SECOND capture that would re-snap the camera back onto Fred.
  async function describeFrames(images, prompt, { isCamera = false } = {}) {
    const kb = images.reduce((s, b) => s + Math.round(b.length / 1024), 0);
    const isMultiScreen = !isCamera && images.length > 1;
    const view = isCamera
      ? 'photo from the user\'s webcam'
      : isMultiScreen
        ? `${images.length} screenshots — one per monitor, in left-to-right order`
        : 'screenshot of the user\'s screen';
    const extra = isMultiScreen
      ? ' If the user asked about a specific monitor, focus on that one; otherwise briefly describe what is on each screen.'
      : '';
    const messages = [
      { role: 'system', content:
        ctxPreamble() + `You are Hannibal, Fred's personal AI assistant. You are shown ${isMultiScreen ? '' : 'a '}${view}.` + extra +
        ' Answer the question directly and concisely — you are spoken aloud, so keep it short and natural.' },
      { role: 'user', content: prompt, images },
    ];
    const visionModel = cfg.ollamaModelVision || cfg.ollamaModel;
    emitModel(visionModel);
    console.log(`[vision] sending ${kb} KB image to ${visionModel} — encoding may take 30-80s before first word`);
    // Claude looks first (it sees images directly); the Ollama vision model on
    // GEX131 is the fallback if Claude is off or unreachable.
    const claude = {
      system: SYSTEM_PROMPT + ' Notes about the current situation and any relevant memories arrive as system messages during the conversation.',
      context: ctxPreamble() + `You are shown ${isMultiScreen ? '' : 'a '}${view}.` + extra
        + ' Answer what Fred asked about it directly, warmly and concisely — you are spoken aloud.',
      user: prompt || (isCamera ? 'How do I look?' : "What's on my screen?"),
      images,
    };
    if (cfg.claudeEnabled) emitModel(cfg.claudeModel);
    await streamChatAndSpeak({
      model: visionModel,
      messages,
      claude,
      // Vision is encode-bound, not just cold-load-bound: Qwen2.5-VL spends 35-80s
      // encoding the frame's vision tokens (it scales with resolution, and the box
      // may be sharing GPU with a 70b) BEFORE the first token streams. The connect
      // timer is cleared once headers/first token arrive, so this only fires on a
      // genuinely unreachable backend — give the encode generous room.
      connectTimeoutMs: 120000,
      errNoun: 'vision model',
    });
  }

  // ── CAMERA STEERING (OBSBOT Tiny 3) ──────────────────────────────────────────
  // Actually MOVES the camera (vs. describeVision's passive snapshot). Directed
  // looks go through camera.look, which releases the AI tracker FIRST, nudges,
  // captures, then returns to Fred — so a look never fights the tracker (STAP 2).
  // HANDS-OFF camera: Hannibal never steers the OBSBOT gimbal — moving it breaks the
  // camera's own tracking, which can't be turned back on (Tiny 3, see camera-
  // coordinator.js). The coordinator refuses steering; here we explain it warmly.
  // Passive "what do you see" still works — that's parseVision → describeVision,
  // which grabs the current frame without moving anything.
  async function handleCamera(cmd) {
    const { action, params = {}, speak } = cmd;
    emitModel('system');
    let res;
    try { res = await window.hannibal.cameraControl(action, params); }
    catch (e) { res = { ok: false, error: String(e) }; }

    if (res && res.handsOff && res.refused) {
      // look / aim / reset / zoom / preset — a steering request we won't honor.
      await speakLine("I don't steer the camera myself — it follows you and turns to whoever's talking on its own.");
    } else if (action === 'track' && res && res.ok) {
      // "follow me" — already true, in hardware.
      await speakLine("I've got you — the camera stays on you on its own.");
    } else if (!res?.ok) {
      console.warn(`[camera] ${action} failed:`, res?.error);
      await speakLine("That didn't work.");
    } else {
      await speakLine(speak || 'Done.');
    }
    startListening({ conversation: true });
  }

  // ── MORNING BRIEFING ────────────────────────────────────────────────────────
  // Gather every live source in parallel, compose a single data block, and have
  // the heavy model deliver it as spoken prose. Promise.allSettled keeps one dead
  // source (e.g. weather) from killing the whole briefing.
  async function morningBriefing() {
    setPhase('thinking');
    emitModel(cfg.ollamaModelHeavy || cfg.ollamaModel);
    emitUser('Morning briefing');

    const [calResult, mailResult, metricsResult, weatherResult, memoryResult] = await Promise.allSettled([
      window.hannibal.calendarEvents(),
      window.hannibal.mailInbox(),
      window.hannibal.systemMetrics(),
      // No path segment → wttr.in geolocates by IP, so the briefing reflects
      // wherever Fred actually is right now (Naarden vs. Ibiza).
      fetch('https://wttr.in/?format=j1').then((r) => r.json()).catch(() => null),
      qdrantReady ? queryMemory('daily priorities current projects tasks', cfg.ollamaUrl, 5) : Promise.resolve([]),
    ]);

    const cal = calResult.status === 'fulfilled' && calResult.value?.ok ? calResult.value : null;
    const mail = mailResult.status === 'fulfilled' && mailResult.value?.ok ? mailResult.value : null;
    const metrics = metricsResult.status === 'fulfilled' && metricsResult.value?.ok ? metricsResult.value : null;
    const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : null;
    const memories = memoryResult.status === 'fulfilled' ? memoryResult.value : [];

    let dataBlock = '';

    const now = new Date();
    dataBlock += `CURRENT TIME: ${now.toLocaleString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}\n\n`;

    if (weather?.current_condition?.[0]) {
      const c = weather.current_condition[0];
      const area = (weather?.nearest_area?.[0]?.areaName?.[0]?.value || 'current location').trim();
      dataBlock += `WEATHER (${area}): ${c.weatherDesc?.[0]?.value || '?'}, ${c.temp_C}°C, feels like ${c.FeelsLikeC}°C, humidity ${c.humidity}%, wind ${c.windspeedKmph} km/h ${c.winddir16Point}\n\n`;
    }

    if (cal?.events?.length) {
      dataBlock += 'CALENDAR TODAY:\n';
      cal.events.filter((e) => e.day === 'today').forEach((e) => { dataBlock += `  - ${e.time}: ${e.title}\n`; });
      const tomorrow = cal.events.filter((e) => e.day === 'tomorrow');
      if (tomorrow.length) {
        dataBlock += 'TOMORROW:\n';
        tomorrow.forEach((e) => { dataBlock += `  - ${e.time}: ${e.title}\n`; });
      }
      dataBlock += '\n';
    } else {
      dataBlock += 'CALENDAR: No events scheduled today.\n\n';
    }

    if (mail) {
      dataBlock += `INBOX: ${mail.unread} unread email${mail.unread !== 1 ? 's' : ''}\n`;
      if (mail.messages?.length) {
        dataBlock += 'Recent:\n';
        mail.messages.forEach((m) => { dataBlock += `  - ${m.unread ? '[UNREAD] ' : ''}${m.from}: ${m.subject}\n`; });
      }
      dataBlock += '\n';
    } else {
      dataBlock += 'INBOX: unavailable.\n\n';
    }

    if (metrics) {
      const ramPct = metrics.mem?.total ? Math.round((metrics.mem.used / metrics.mem.total) * 100) : '?';
      const gpuStatus = metrics.gpu ? `${metrics.gpu.util}% load, ${metrics.gpu.temp}°C` : 'offline';
      dataBlock += `GEX131 STATUS: RAM ${ramPct}%, GPU ${gpuStatus}\n\n`;
    }

    if (memories.length) {
      dataBlock += 'RECENT CONTEXT FROM MEMORY:\n';
      memories.forEach((m) => { dataBlock += `  - ${m.text}\n`; });
      dataBlock += '\n';
    }

    console.log('[briefing] data gathered:\n' + dataBlock);

    const briefingPrompt = `You are Hannibal, Fred Legrand's personal AI. Deliver a morning briefing.

Rules:
- Spoken aloud, so be natural and conversational — like a chief of staff briefing the boss
- Start with a greeting that includes the day and weather
- Cover calendar, mail highlights (only mention important/actionable ones, skip receipts/notifications), and system status
- If memory shows what Fred was working on, mention it naturally as context
- End with a forward-looking line — what the day looks like
- Keep it under 90 seconds when spoken (roughly 200-250 words)
- No bullet points, no markdown — pure spoken prose
- Be direct, no fluff. Fred starts at 4am. Respect his time.

DATA:
${dataBlock}`;

    const messages = [
      { role: 'system', content: ctxPreamble() + briefingPrompt },
      { role: 'user', content: 'Give me my morning briefing.' },
    ];

    await streamChatAndSpeak({
      model: cfg.ollamaModelHeavy || cfg.ollamaModel,
      messages,
      errNoun: 'briefing model',
    });

    startListening({ conversation: true });
  }

  // ── AGENT LOOP ──────────────────────────────────────────────────────────────
  // The agentic core. Gathers context (screenshot + active app + memory), hands it
  // to the LLM with the tool prompt, executes the [ACTION:...] tags it emits, and —
  // if the model adds [CONTINUE] — re-screenshots and loops up to maxSteps. Speech
  // is de-tagged (stripTags) so tool syntax is never spoken.
  async function agentLoop(userRequest, { withScreenshot, maxSteps = 5 } = {}) {
    setPhase('thinking');

    // Only screenshot when the request actually refers to the screen. Otherwise we
    // stay text-only and use the heavy 70b, which follows the structured tag format
    // far better than the 7b vision model (which mangles app names / merges tags).
    const useScreen = withScreenshot === undefined ? needsScreen(userRequest) : withScreenshot;
    let screenContext = '';
    let screenB64 = null;
    if (useScreen) {
      const cap = await window.hannibal.capture('screen');
      if (cap?.ok && cap?.b64) { screenB64 = cap.b64; screenContext = '\n[A screenshot of the current screen is attached.]'; }
    }

    let activeApp = '';
    try {
      const r = await window.hannibal.macControl('shell',
        `osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`);
      if (r?.success && r?.data) activeApp = r.data.trim();
    } catch (_) {}

    let memoryContext = '';
    if (qdrantReady) {
      const memories = await queryMemory(userRequest, cfg.ollamaUrl, 3);
      if (memories.length) memoryContext = '\nRELEVANT MEMORY:\n' + memories.map((mm) => `- ${mm.text}`).join('\n');
    }

    // Model is chosen per step by whether the prompt currently carries an image:
    // text-only steps → heavy 70b; any step with a screenshot (initial or via
    // [CONTINUE]) → vision model, since only it can read the image.
    const visionModel = cfg.ollamaModelVision || cfg.ollamaModel;
    const heavyModel = cfg.ollamaModelHeavy || cfg.ollamaModel;
    let hasImage = !!screenB64;

    const AGENT_PROMPT = `You are Hannibal, Fred Legrand's personal AI assistant running on his Mac.
You can see his screen and control his computer. You are spoken aloud.

ACTIVE APPLICATION: ${activeApp || 'unknown'}
${memoryContext}
${screenContext}

YOU CAN EXECUTE THESE ACTIONS by including them in your response:
[APP: open|AppName] — open any Mac application (Terminal, Chrome, WhatsApp, Finder, VS Code, Safari, Spotify, etc)
[APP: quit|AppName] — quit an application
[APP: switch|AppName] — bring an app to front

[BROWSER: open|url] — navigate to a URL
[BROWSER: search|query] — Google search
[BROWSER: youtube|query] — YouTube search
[BROWSER: bookmark|name] — open a bookmark (supabase, vercel, github, drive, chatgpt, n8n, stripe, twitter, linkedin, revalis)
[BROWSER: click-link|visible text] — click a link or button by its text
[BROWSER: type-in-browser|text] — type into the focused input field
[BROWSER: tab|new] — new tab
[BROWSER: close-tab|] — close current tab
[BROWSER: next-tab|] / [BROWSER: prev-tab|]
[BROWSER: back|] / [BROWSER: forward|] / [BROWSER: refresh|]
[BROWSER: scroll-down|] / [BROWSER: scroll-up|]
[BROWSER: read-content|] — read the text on the current page
[BROWSER: read-page|] — get current page title and URL

[SYSTEM: volume-up|] / [SYSTEM: volume-down|] / [SYSTEM: volume-set|0-100]
[SYSTEM: volume-mute|] / [SYSTEM: volume-unmute|]
[SYSTEM: dark-mode|on] / [SYSTEM: dark-mode|off] / [SYSTEM: dark-mode-toggle|]
[SYSTEM: brightness-up|] / [SYSTEM: brightness-down|]
[SYSTEM: lock|] / [SYSTEM: sleep|]
[SYSTEM: battery|] / [SYSTEM: disk-space|] / [SYSTEM: uptime|] / [SYSTEM: ip-address|]
[SYSTEM: wifi-status|] / [SYSTEM: wifi-toggle|on/off]
[SYSTEM: find-file|name] / [SYSTEM: desktop-files|] / [SYSTEM: downloads-files|] / [SYSTEM: recent-files|]
[SYSTEM: file-search|{"query":"name","type":"pdf|doc|all","location":"all|downloads|desktop|documents|projects"}]
  — Spotlight-backed name+location search; returns up to 10 hits with paths.
  Most natural "find <name>" phrasings hit a local fast path before you see them.
[SYSTEM: file-list|{"folder":"~/path","sort":"recent|name|size"}] — directory listing.
[SYSTEM: file-open|/absolute/path] — open a file with its default app.
[SYSTEM: file-recent|{"hours":24,"type":"all|pdf|doc|code"}] — recently changed files.
[SYSTEM: file-read|/absolute/path] — read a small text file. Hannibal's renderer
  speaks short files as-is and summarizes long ones; you don't need to summarize.
[SYSTEM: clipboard-get|] / [SYSTEM: clipboard-set|text]
[SYSTEM: list-apps|] — list running applications
[SYSTEM: dnd-on|] / [SYSTEM: dnd-off|]
[SYSTEM: screenshot|]
[SYSTEM: notify|message] — show a macOS notification
[SYSTEM: shell|command] — run any shell command
[SYSTEM: open-in-editor|{"editor":"claude|cc|cursor|code","project":"name-or-path"}] — open a project folder in a dev tool

[SPOTIFY: play|] / [SPOTIFY: pause|] / [SPOTIFY: next|] / [SPOTIFY: prev|] / [SPOTIFY: current|]

[WHATSAPP: send|{"contact":"name","message":"text"}] — send a WhatsApp message
[WHATSAPP: search|name] — open WhatsApp and search for a contact

[EMAIL: send|{"to":"email","subject":"text","body":"text"}] — compose an email
[EMAIL: check|] — fetch the Zoho inbox summary (unread count + recent senders).
  Fred's email is Zoho Mail, NOT Gmail. Never open Gmail or any browser for
  email; the inbox is already loaded via IMAP. Most "read email" / "check
  email" phrasings hit a faster local path before you see them — if it
  reached you, the user wants something the fast path doesn't cover.

[CONTINUE] — request a fresh screenshot AFTER your action runs, for genuine
multi-step tasks where the next step depends on what's now on screen.

  USE [CONTINUE] ONLY when ALL of these are true:
  - The task has MORE THAN ONE step that you still need to do.
  - The next step depends on reading something from the screen (a URL, a
    confirmation message, the result of a search, content of an opened doc).
  - Verifying the prior step worked is not enough — you need to ACT on what
    you see next.

  NEVER use [CONTINUE] for one-shot actions. These are DONE after one tag:
    "open Slack"            → [APP: open|Slack]                    (no CONTINUE)
    "open Spotify"          → [APP: open|Spotify]                  (no CONTINUE)
    "open CC in hannibal"   → [SYSTEM: open-in-editor|{…}]         (no CONTINUE)
    "play music"            → [SPOTIFY: play|]                     (no CONTINUE)
    "turn on dark mode"     → [SYSTEM: dark-mode|on]               (no CONTINUE)
    "send a WhatsApp to Mandy saying hello" →
       [WHATSAPP: send|{"contact":"Mandy","message":"hello"}]      (no CONTINUE)
    "what's my battery"     → [SYSTEM: battery|]                   (no CONTINUE)

  GOOD use of [CONTINUE]:
    "find that email from Jean-Marc and open the link inside it"
      → [EMAIL: check|] [CONTINUE]   ← read the Zoho inbox summary
      next step: locate the email by sender, open the link.
    "send Robert an email then check my calendar"
      → [EMAIL: send|{…}] [CONTINUE]
      next step: [SYSTEM: todays-events|] or similar.

If you are uncertain whether to use [CONTINUE], DON'T. A spurious [CONTINUE]
makes a second LLM call that can fail and confuse the user even though the
real action already worked.

WEBSITES vs APPS — this is critical:
- These are WEBSITES (no first-class Mac app, or web is the canonical surface).
  Open them with [BROWSER: bookmark|name], NEVER as an app:
  chatgpt, supabase, vercel, github, drive, docs, sheets, n8n, lovable,
  stripe, twitter, x, linkedin, youtube, revalis, suite synq, mellow yellow.
  Example: "open Supabase" → [BROWSER: bookmark|supabase]   (NOT an app)
- EMAIL: Fred uses Zoho Mail, NOT Gmail. NEVER emit [BROWSER: bookmark|gmail],
  [BROWSER: open|gmail.com], or any browser path for "read email", "check
  email", "any new mail", etc. Use [EMAIL: check|] only — and even that is
  usually unnecessary because "read email"-style phrasing hits a local
  fast path before reaching you.
- These have first-class Mac apps and "open X" means the APP, not the website:
  Calendar, Slack, Notion, Claude, Discord, Figma, Cursor, Spotify, WhatsApp,
  Messages, Mail, Notes, Reminders, Music, Finder, Terminal, Safari, Chrome,
  VS Code (and the Office suite, etc).
  Example: "open Slack" → [APP: open|Slack]   (NOT [BROWSER: bookmark|slack])
- For any other website, use [BROWSER: open|url] with a lowercase URL.
  Example: "go to RevalisHousing.com" → [BROWSER: open|revalishousing.com]
- [APP: open|...] now does smart resolution (alias map + fuzzy /Applications),
  so you can pass the spoken name directly — "Chrome", "VS Code", "Code" all
  work. EXACT macOS name still works too if you have it.
- For dev editors + a project, prefer [SYSTEM: open-in-editor|{"editor":"...",
  "project":"..."}] over [APP: open|...]. Editors: claude/cc, cursor, code/vscode.
  Example: "open hannibal-v2 in cursor" →
    [SYSTEM: open-in-editor|{"editor":"cursor","project":"hannibal-v2"}]

TAG FORMAT — strict:
- Use EXACTLY one '|' separating the action from its parameter: [TYPE: action|param].
- NEVER merge the action and parameter. Wrong: [BROWSER: open url|site.com]. Right: [BROWSER: open|site.com].
- NEVER write more than one '|'. Wrong: [BROWSER: open|url|site.com]. Right: [BROWSER: bookmark|supabase].
- The action is a single token from the lists above (e.g. open, bookmark, search, scroll-down). Anything else goes after the '|'.
- If an action takes no parameter, still close the tag: [BROWSER: refresh|].

MOST IMPORTANT RULE — ACT, DON'T DESCRIBE:
- If the request is an action, you MUST include the action tag. Saying you'll do something WITHOUT the tag does NOTHING — the tag is the only thing that actually runs.
- Never say "I'll check that" or "let me open that" without the matching tag in the SAME response.
- When in doubt, emit the tag.

EXAMPLES (note: the tag is always present for actions):
User: "What's my battery?"
You: "Checking your battery now. [SYSTEM: battery|]"

User: "What percentage is my battery?"
You: "Let me check. [SYSTEM: battery|]"

User: "Open Supabase"
You: "Pulling up Supabase. [BROWSER: bookmark|supabase]"

User: "Read my email" / "Check my inbox"
(This routes to the IMAP fast path before you see it. If it DID reach you,
respond conversationally — don't open Gmail.)

User: "Turn on dark mode and set volume to 30"
You: "Done. [SYSTEM: dark-mode|on] [SYSTEM: volume-set|30]"

User: "Open Chrome"
You: "Opening Chrome. [APP: open|Google Chrome]"

User: "Open Slack" / "Open Notion" / "Open Calendar"
You: "Opening Slack. [APP: open|Slack]"
(These have native Mac apps — use [APP: open|...], not the bookmark.)

User: "Open hannibal-v2 in Cursor" / "Open CC in mellow yellow"
You: "Opening hannibal-v2 in Cursor. [SYSTEM: open-in-editor|{\"editor\":\"cursor\",\"project\":\"hannibal-v2\"}]"

RULES:
- Be concise — you're spoken aloud. 1-2 sentences of speech, then action tags.
- Put your spoken response BEFORE the action tags.
- You can chain multiple actions in one response.
- If the task genuinely needs no action (pure conversation), just respond naturally.
- [CONTINUE] is reserved for genuine multi-step tasks where the next step needs
  to read the screen. See the [CONTINUE] section above for when to use it. Do
  NOT add [CONTINUE] to one-shot actions ("open Slack", "play music", "send
  this message", etc) — the action is already done.`;

    const messages = [
      { role: 'system', content: ctxPreamble() + AGENT_PROMPT },
      { role: 'user', content: userRequest, ...(screenB64 ? { images: [screenB64] } : {}) },
    ];

    // Normalize a reply to its spoken prose (tags stripped) for stutter detection.
    const speechOf = (s) => s.replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const nearlySame = (a, b) => {
      if (!a || !b) return false;
      if (a === b) return true;
      const [short, long] = a.length <= b.length ? [a, b] : [b, a];
      return long.includes(short) && short.length / long.length > 0.8;   // one ⊇ other, ≥80% overlap
    };

    let step = 0;
    let lastReply = '';
    let prevSpoken = '';
    let retried = false;
    let executedAny = false;                       // any prior step actually ran an action
    while (step < maxSteps) {
      step++;
      const model = hasImage ? visionModel : heavyModel;
      emitModel(model);
      console.log(`[agent] step ${step}/${maxSteps} model=${model}${hasImage ? ' (vision)' : ''}`);

      lastReply = (await streamChatAndSpeak({
        model,
        messages,
        connectTimeoutMs: 120000,
        errNoun: step === 1 ? 'assistant' : 'agent',
        stripTags: true,
        // Once we've already executed an action, a flaky [CONTINUE] follow-up
        // must not override the success the user just heard/saw. First step
        // (and pre-action retries) still surface real connectivity failures.
        speakErrors: !executedAny,
      })) || '';

      const actions = parseActionTags(lastReply);
      let needsContinue = false;
      let executed = 0;
      let pendingArmed = false;       // miss-recovery prompt fired this turn
      for (const a of actions) {
        if (a.type === 'CONTINUE') { needsContinue = true; continue; }
        executed++;
        console.log(`[agent] executing: ${a.type} ${a.action} ${a.params}`);
        let actionResult;
        try { actionResult = await executeAction(a); executedAny = true; }
        catch (e) { console.warn('[agent] action failed:', e.message); }

        // ── WhatsApp miss recovery ──
        // The backend whatsapp-send AppleScript returns a SUCCESSFUL result
        // shape but with data === "ERROR: no chat row matched 'X'" when the
        // fuzzy search through the WhatsApp chat list comes up empty. Detect
        // that string and offer a fuzzy candidate from ALIASES.names values.
        if (a.type === 'WHATSAPP' && a.action === 'send'
            && actionResult && actionResult.success
            && typeof actionResult.data === 'string'
            && /^ERROR: no chat row matched/i.test(actionResult.data)) {
          let originalParams = null;
          try { originalParams = JSON.parse(a.params); } catch (_) {}
          if (originalParams && originalParams.contact) {
            const suggestion = suggestContactMatch(originalParams.contact);
            // Same-name guard — if the suggestion equals what we already tried,
            // there's no recovery to offer (contact genuinely not in WhatsApp).
            if (suggestion && suggestion.toLowerCase() !== String(originalParams.contact).toLowerCase()) {
              pendingConfirmation = {
                context: 'whatsapp-send',
                category: 'names',
                original: originalParams.contact,
                suggested: suggestion,
                retry: async () => {
                  const newParams = JSON.stringify({ ...originalParams, contact: suggestion });
                  const r2 = await window.hannibal.macControl('whatsapp-send', newParams);
                  const data = r2 && r2.success ? String(r2.data || '') : '';
                  if (/^ERROR/i.test(data)) await speakLine(`Still couldn't find ${suggestion} in WhatsApp.`);
                  else await speakLine(`Sent to ${suggestion}.`);
                  startListening({ conversation: true });
                },
              };
              await speakLine(`I couldn't find ${originalParams.contact} in WhatsApp. Did you mean ${suggestion}?`);
              pendingArmed = true;
              break;        // stop processing further tags this turn
            }
          }
        }
      }

      // If we armed a confirmation prompt, exit the agent loop entirely —
      // the next user utterance will be consumed by handleCommand's
      // confirmation gate (yes → retry & learn, no → drop it).
      if (pendingArmed) { startListening({ conversation: true }); return; }

      // Retry once if the model described an action but emitted no tag (the
      // "I'll check your battery" failure). Nudge it to actually emit the tag.
      if (executed === 0 && !needsContinue && !retried && step < maxSteps) {
        retried = true;
        console.warn('[agent] reply had no action tags — retrying with a corrective nudge');
        messages.push({ role: 'assistant', content: lastReply });
        messages.push({ role: 'user', content: 'You described an action but emitted no action tag, so nothing actually happened. Reply again and INCLUDE the correct [TYPE: action|param] tag(s) to perform it now. If it truly needs no action, say so plainly.' });
        continue;
      }

      // Stutter guard: if this step's spoken text is ~the same as the previous
      // step's, the model is looping ("navigating to nu.nl" → [CONTINUE] → repeat).
      // Stop honoring [CONTINUE] so it can't spin until it errors out.
      const spoken = speechOf(lastReply);
      const stutter = nearlySame(spoken, prevSpoken);
      prevSpoken = spoken;

      if (needsContinue && !stutter && step < maxSteps) {
        await sleep(1500);                       // let the action settle (page load, app switch…)
        const cap = await window.hannibal.capture('screen');
        if (cap?.ok && cap?.b64) {
          messages.push({ role: 'assistant', content: lastReply });
          messages.push({ role: 'user', content: 'Here is the updated screen. Continue with the task.', images: [cap.b64] });
          hasImage = true;                       // next step needs the vision model
        } else break;                            // can't see — stop looping
      } else {
        if (stutter && needsContinue) console.warn('[agent] stutter detected — breaking the [CONTINUE] loop');
        break;                                   // no [CONTINUE], or repeating itself — done
      }
    }

    if (qdrantReady && lastReply) {
      storeMemory(`Fred asked: ${userRequest}\nHannibal did: ${lastReply.slice(0, 500)}`, cfg.ollamaUrl, { type: 'agent-action' }).catch(() => {});
    }

    startListening({ conversation: true });
  }

  // Run a typed/clicked command through the exact same pipeline as a spoken turn:
  // route to a direct action (browser/system/vision) or fall through to LLM chat.
  // Used by the Quick Actions pills — "clicking sends the command as if spoken".
  async function submitText(text) {
    let t = (text || '').trim();
    if (!t) return;
    if (confirmInFlight) return;                               // gate active — ignore other input
    if (phase === 'listening' || phase === 'thinking') return; // busy
    // If Fred typed/clicked while we were still talking, that's an interrupt
    // signal — the response was too long for him at this moment.
    if (phase === 'speaking' && lastTaskType) recordInterruption(lastTaskType);
    unlock();
    // Run the same Whisper/name-alias normalization as voice so typed
    // "rivalis" / "suite sync" / etc. land on canonical project identifiers
    // before parseCommand sees them. (Spoken input went through this at the
    // mic level on line 236; typed input previously skipped it.)
    t = fixTranscript(t);
    console.log('[voice] submitText:', JSON.stringify(t));
    emitUser(t);
    const wasTeaching = teachState !== null;
    if (await handleCommand(t)) {
      if (!wasTeaching) logBehavior(t);
      return;
    }
    await respond(t);
  }

  // ── triggers ──────────────────────────────────────────────────────────────
  window.hannibal.onWake(async () => {
    wokeAt = Date.now();
    if (confirmInFlight) return;   // a confirmation is pending — wake must not start a competing capture
    // Wake fired while still speaking → Fred is cutting in. Attribute the
    // interrupt to whatever task was talking. This is the primary signal for
    // "response was too long" — at 3 hits per task type, the override flips
    // that task's default length to 'short'.
    unlock();
    // The wake word while he talks = stop talking and listen (his own voice
    // never says it, so this one is reliable even over the speakers).
    if (phase === 'speaking' || speaking) {
      console.warn('[barge] stopped by the wake word');
      bargeStop();
      setPhase('idle');
      startListening({ conversation: true });
      return;
    }
    // Context-aware greeting on wake-from-idle. Suppress on quick re-wakes
    // (within 5 min) so a back-to-back "hey hannibal" doesn't make Hannibal
    // re-greet on every utterance. Greeting is short (1-2 seconds of TTS)
    // and prepends a "welcome back" sentiment if Fred has been away ≥ 2h.
    const now = Date.now();
    const wasIdle = phase === 'idle';
    if (wasIdle && (now - lastGreetingTime > 5 * 60 * 1000)) {
      lastGreetingTime = now;
      const awayMs = now - lastActivityTime;
      const ctx = getContext();
      emitModel('system');
      try { await speakLine(buildGreeting(ctx, awayMs)); }
      catch (_) {}
    }
    // Wake re-arms always-listen if it's the configured default (e.g. after a
    // prior "go idle"). With the flag off this stays false → classic behavior.
    if (cfg.alwaysListen) continuousListen = true;
    startListening();
  });

  // ── Proactive care ping ──
  // Every 30 min, see if Fred deserves a gentle nudge. Two conditions:
  //   (a) 12+ hours since the first command of today → "wrap up soon"
  //   (b) past midnight with active commands → "tomorrow is another day"
  // Constraints (so this never becomes nagging):
  //   • Only fires when phase === 'idle' (no interrupting active conversation)
  //   • Max once per hour total, regardless of which condition matched
  //   • Skips if mood is 'in_the_zone' — Fred is mid-flow, don't break it
  //   • Sets Hannibal's state to 'warm' temporarily via the speech itself;
  //     no separate state flag needed
  let lastCarePingTime = 0;
  setInterval(() => {
    try {
      // Rest = 'idle', OR the restful open-mic window in always-listen mode.
      if (phase !== 'idle' && !restfulListen) return;
      if (autonomousSpeaking) return;
      if (currentMood === 'in_the_zone') return;
      const now = Date.now();
      if (now - lastCarePingTime < 60 * 60 * 1000) return;
      if (recentTaskTimes.length === 0) return;
      const ctx = getContext();
      const startMs = recentTaskTimes[0];
      const hoursWorked = (now - startMs) / (60 * 60 * 1000);
      let line = null;
      if (hoursWorked >= 12) {
        const startD = new Date(startMs);
        const pad = (n) => String(n).padStart(2, '0');
        line = `Fred, you've been at it since ${pad(startD.getHours())}:${pad(startD.getMinutes())}. Maybe wrap up soon.`;
      } else if ((ctx.hour >= 0 && ctx.hour < 5) && (now - lastActivityTime) < 15 * 60 * 1000) {
        line = "It's past midnight, Fred. Tomorrow is another day.";
      }
      if (line) {
        lastCarePingTime = now;
        emitModel('system');
        speakAutonomous(line).catch(() => {});   // cleanly takes the open mic in always-listen mode
      }
    } catch (e) { console.warn('[care-ping] error', e); }
  }, 30 * 60 * 1000);   // every 30 minutes

  // ── Reminder + timer tick (1 Hz) ──
  // Walks both lists each second and fires any whose triggerTs has passed.
  // Marks them `fired: true` instead of deleting so the JSON history shows
  // when each one resolved. A cleanup pass removes very old fired entries
  // so the files don't grow unbounded.
  setInterval(async () => {
    try {
      const now = Date.now();
      // Whether an autonomous line may fire right now. Legacy: any time Hannibal
      // isn't speaking. Always-listen: only at a resting moment (idle or the
      // restful open-mic window) so we never cut off a live utterance — the tick
      // retries every second, so a due item just waits until Fred pauses.
      const canAnnounce = !autonomousSpeaking &&
        (continuousListen ? (phase === 'idle' || restfulListen) : phase !== 'speaking');
      // Reminders — only fire if Hannibal isn't currently speaking (so we
      // don't talk over another reply). If busy, the next tick will catch it.
      const dueReminders = REMINDERS.filter((r) => !r.fired && r.triggerTs <= now);
      if (dueReminders.length && canAnnounce) {
        // Take the mic cleanly for the whole batch (always-listen: closes the open
        // resting turn, suppresses the re-arm until we're done, then reopens once).
        autonomousSpeaking = true;
        if (phase === 'listening') abortListening();
        for (const r of dueReminders) {
          r.fired = true;
          r.firedAt = now;
          emitModel('system');
          try { window.hannibal.reminderFired && window.hannibal.reminderFired(r.message || 'you asked me to remind you'); } catch (_) {}
          try { await speakLine(`Fred, reminder: ${r.message || 'you asked me to remind you'}.`); }
          catch (_) {}
        }
        // GC anything fired > 24h ago
        REMINDERS = REMINDERS.filter((r) => !r.fired || (now - (r.firedAt || 0)) < 86400000);
        await saveReminders();
        autonomousSpeaking = false;
        restOrRearm();
      }
      // Timers — fire even mid-speech for short countdowns? Safer to also
      // gate on idle so user doesn't get talked over.
      const dueTimers = TIMERS.filter((t) => !t.fired && t.triggerTs <= now);
      if (dueTimers.length && canAnnounce) {
        autonomousSpeaking = true;
        if (phase === 'listening') abortListening();
        for (const t of dueTimers) {
          t.fired = true;
          t.firedAt = now;
          // Quick alert sound + spoken line.
          try { await window.hannibal.macControl('shell', `afplay /System/Library/Sounds/Glass.aiff &`); } catch (_) {}
          emitModel('system');
          try {
            const minutes = Math.round((t.triggerTs - t.createdTs) / 60000);
            const label = t.label ? `your ${t.label} timer` : `your ${minutes} minute timer`;
            await speakLine(`Fred, ${label} is up.`);
          } catch (_) {}
        }
        // GC anything fired > 1h ago (timers are short-lived by nature)
        TIMERS = TIMERS.filter((t) => !t.fired || (now - (t.firedAt || 0)) < 3600000);
        await saveTimers();
        autonomousSpeaking = false;
        restOrRearm();
      }
    } catch (e) { console.warn('[tick] error', e); }
  }, 1000);   // every second

  // ── CONFIRMATION GATE (Stage 4) — voice/click "send it?" ────────────────────
  // The renderer half of the gate. main.js asks before every confirm:true write
  // (one ask per action). We speak the summary, then accept EITHER a spoken
  // answer OR a click — whichever lands first — and reply with the decision.
  //
  // DENY-BY-DEFAULT is the whole posture: ONLY a clean, unambiguous affirmative
  // is a yes. Silence, a hedge ("uh", "wait"), a half-word, an off-topic phrase,
  // an explicit no, a mic failure, a handler error — every one resolves to NO. A
  // gate that treats ambiguity as approval feels safe while it isn't.
  const CONFIRM_YES = /^(y|yes|yeah|yep|yup|yes please|ya|ja|jawel|oui|si|sí|sure|ok|okay|do it|send it|send|send that|book it|delete it|move it|delete|deleted|delete that|delete it please|remove it|move|moved|move that|book|booked|book that|vas-y|d'accord|supprime|supprime-le|efface|déplace|verwijder|verwijder maar|verwijderen|verplaats|vale|claro|go|go ahead|confirm|confirmed|approve|approved|affirmative|doe maar|graag)$/i;
  // "Yes, book it, Hannibal" / "okay go ahead please": a clean yes plus only
  // filler that adds no doubt. Anything else after it (", but…", "wait") is not a yes.
  const YES_WORDS = /^(yes please|yes|yeah|yep|yup|ya|ja|jawel|oui|si|sí|sure|ok|okay|do it|send it|send that|send|book it|delete it|move it|delete it please|delete that|deleted|delete|remove it|move that|moved|move|book that|booked|book|vas-y|d'accord|supprime|supprime-le|efface|déplace|verwijder maar|verwijderen|verwijder|verplaats|vale|claro|go ahead|go|confirm|confirmed|approve|approved|affirmative|doe maar|graag|please|thanks|thank you|hannibal|that's fine|that is fine|fine|perfect|great|good|dank je|merci)(?=\s|$)/i;
  const YES_FILLER = /^(please|thanks|thank you|hannibal|book it|do it|go ahead|send it|that's fine|that is fine|fine|perfect|great|good|sure|yes|yeah|ok|okay|graag|dank je|merci)$/i;
  const CONFIRM_NO  = /^(n|no|nope|nah|don'?t|do not|stop|cancel|wait|hold on|hold up|never ?mind|negative|nee|non|skip|not now|leave it|abort)$/i;

  function classifyConfirmation(raw) {
    const t = String(raw || '').trim().toLowerCase().replace(/^[\s.!?,]+/, '').replace(/[\s.!?,]+$/, '');
    if (!t) return 'silence';               // nothing heard at all
    if (CONFIRM_YES.test(t)) return 'yes';  // a clean affirmative and nothing more
    if (CONFIRM_NO.test(t)) return 'no';    // an explicit negative / hedge
    // "yes yes", "yes, book it", "okay go ahead please": made up ONLY of yes-words
    // and harmless filler, starting with a yes. Eat known phrases from the front;
    // anything left over ("but", "tomorrow", "cancel") means it is not a clean yes.
    let rest = t.replace(/[,.!?;:]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^((uh|um|uhm|eh|ehm|oh|ah)\s+)+/, '');
    let first = true, ok = true;
    while (rest && ok) {
      const m = YES_WORDS.exec(rest);
      if (!m || (first && !CONFIRM_YES.test(m[1]))) { ok = false; break; }
      first = false; rest = rest.slice(m[0].length).trim();
    }
    if (ok && !first) return 'yes';
    return 'unclear';                        // anything else — treated as NO
  }

  // Record exactly ONE short utterance; return its transcript, or null on
  // silence/timeout. Uses its own mic + recorder so it never collides with the
  // normal listening loop's shared state.
  let confirmCancel = null;
  async function recordConfirmation(windowMs = 8000) {
    setPhase('listening');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { console.warn('[gate] mic unavailable', e); return null; }
    const srcNode = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser(); analyser.fftSize = 512;
    srcNode.connect(analyser);
    const freq = new Uint8Array(analyser.frequencyBinCount);
    const localChunks = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && localChunks.push(e.data);
    return await new Promise((resolve) => {
      let timer = null, settled = false;
      const stop = () => { if (settled) return; settled = true; if (timer) clearInterval(timer); if (rec.state !== 'inactive') rec.stop(); };
      confirmCancel = stop;   // a winning click can short-circuit the capture
      rec.onstop = async () => {
        confirmCancel = null;
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(localChunks, { type: 'audio/webm' });
        if (!blob.size) { resolve(null); return; }
        const code = LANG_CODE[currentLanguage] || 'en';
        try {
          const r = await fetch(`${cfg.whisperUrl}/transcribe?language=${code}`, { method: 'POST', body: blob });
          const j = await r.json();
          resolve(fixTranscript(((j && j.transcript) || '').trim()));
        } catch (e) { console.warn('[gate] transcribe failed', e); resolve(null); }
      };
      rec.start();
      // The same per-room floor the normal listening loop calibrated, not the old
      // fixed 15: in a room whose hum sits above 15 the answer never "ended" and
      // the gate hung for good. A hard cap makes sure it always ends.
      const onset = Math.max(SILENCE_THRESH, speechThreshold);
      const release = Math.max(SILENCE_THRESH, noiseFloor + NOISE_RELEASE_MARGIN);
      const HARD_CAP_MS = windowMs + 6000;
      const t0 = performance.now(); let lastLoud = t0, streak = 0, heard = false;
      // The room right now can be louder than when it was calibrated (music, a
      // fan, the TV). Learn it from the moments before Fred speaks, and also call
      // it "quiet" once the level falls well under his own speaking level, so the
      // answer ends on his pause instead of running into the time cap.
      const pre = []; let speechSum = 0, speechN = 0;
      timer = setInterval(() => {
        analyser.getByteFrequencyData(freq);
        let sum = 0; for (let i = 0; i < freq.length; i++) sum += freq[i];
        const avg = sum / freq.length, now = performance.now();
        if (avg >= onset) streak++; else streak = 0;
        if (streak >= SPEECH_ONSET_SAMPLES) heard = true;
        if (!heard) { pre.push(avg); if (pre.length > 30) pre.shift(); }
        else if (avg >= onset) { speechSum += avg; speechN++; }
        const room = pre.length ? [...pre].sort((x, y) => x - y)[Math.floor(pre.length / 2)] : 0;
        const quietBelow = Math.max(release, room + NOISE_RELEASE_MARGIN, speechN ? (speechSum / speechN) * 0.55 : 0);
        if (avg > quietBelow) lastLoud = now;
        if (now - t0 > HARD_CAP_MS) { console.warn('[gate] answer capture hit the time cap'); stop(); return; }
        if (!heard) { if (now - t0 > windowMs) stop(); return; }  // no speech in window → NO
        if (now - lastLoud > Math.min(SILENCE_MS, 1500)) stop();  // trailing pause → answer done
      }, 100);
    });
  }

  async function handleConfirmRequest(req) {
    // main asks per-action and awaits each reply, so only one is ever in flight;
    // deny any overlap defensively.
    if (confirmInFlight) { try { window.hannibal.agentConfirmResponse(req.id, false); } catch (_) {} return; }
    confirmInFlight = true;   // from here, the normal voice loop is fully suspended
    // Seize the mic: stop any in-progress normal capture so its recorder can't
    // also grab the spoken answer. finishListening() no-ops while confirmInFlight,
    // so this won't transcribe, route to chat, or change the phase.
    try { stopListening(); } catch (_) {}
    unlock();
    // let any in-flight agent narration finish so the gate prompt doesn't overlap it
    for (let w = 0; narrating && w < 30; w++) await new Promise((r) => setTimeout(r, 50));
    // ...and let Claude finish the sentence it's saying before the tool call (≤15s)
    for (let w = 0; (speakQueue.length || playingOne) && w < 300; w++) await new Promise((r) => setTimeout(r, 50));
    let decided = false, decision = false, gateUI = null, heardVerdict = null;
    const finalize = (val, how) => {
      if (decided) return;
      decided = true; decision = !!val;
      console.warn(`[gate] "${req.summary}" → ${decision ? 'YES' : 'NO'} (${how})`);
      try { if (confirmCancel) confirmCancel(); } catch (_) {}
    };
    try {
      // 1) VOICE IS PRIMARY. Render the gate row (summary + "listening" hint) but
      //    keep the Yes/No buttons HIDDEN — they're revealed only if voice misses.
      try {
        gateUI = (onConfirm && onConfirm(
          { summary: req.summary, tool: req.tool, step: req.step },
          (v) => finalize(v, 'click'),
        )) || null;
      } catch (_) {}
      // 2) speak the summary
      emitModel('system');
      try { await speakLine(req.summary); } catch (_) {}
      // 3) take a spoken answer. Capture starts only AFTER the TTS finishes (so we
      //    don't record Hannibal's own voice tail, which VAD discards as noise),
      //    with a short settle lead-in. If the mic/VAD hands back nothing clean,
      //    re-ask ONCE — and only THEN reveal the buttons as a backup — before
      //    defaulting to NO. Still deny-by-default.
      const SETTLE_MS = 550;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let attempt = 0; attempt < 2 && !decided; attempt++) {
        if (attempt === 1) {
          try { gateUI && gateUI.reveal(); } catch (_) {}   // voice missed → show the button backup
          emitModel('system');
          try { await speakLine("I didn't catch that — yes or no?"); } catch (_) {}
        }
        await sleep(SETTLE_MS);            // let the TTS tail clear → clean audio for VAD
        if (decided) break;               // a click landed during the prompt/settle
        const heard = await recordConfirmation();
        if (decided) break;               // a click won during capture
        if (heard == null || heard === '') {
          console.warn(`[gate] confirm: VAD/no clean speech (attempt ${attempt + 1}/2)`);
          continue;                        // re-ask, or fall through to NO after the 2nd miss
        }
        heardVerdict = classifyConfirmation(heard);
        console.warn(`[gate] heard "${heard}" → ${heardVerdict}`);
        finalize(heardVerdict === 'yes', `voice:${heardVerdict}`);
      }
      if (!decided) finalize(false, 'silence');   // deny-by-default after one honest re-ask
    } catch (e) {
      console.warn('[gate] handler error', e);
      finalize(false, 'error');
    }
    if (gateUI) { try { gateUI.finish(decision); } catch (_) {} }
    // deny-by-default transparency: say why when it wasn't a clean yes
    try {
      if (decision) await speakLine('On it.');
      else if (heardVerdict === 'no') await speakLine('Okay, leaving it.');
      else await speakLine("I didn't get a clear yes, so I'll hold off.");
    } catch (_) {}
    confirmInFlight = false;
    try { window.hannibal.agentConfirmResponse(req.id, decision); } catch (_) {}
    restOrRearm();   // always-listen: return to the open mic (else just idles)
  }

  if (window.hannibal && window.hannibal.onAgentConfirmRequest) {
    window.hannibal.onAgentConfirmRequest(handleConfirmRequest);
  }

  // ── AGENT PROGRESS (Stage 6) — spoken progress, brain cascade per step, a
  //    final answer in the goal's language, and a memory summary on completion.
  //    Driven by the executor's progress events (main → agent:progress). This is
  //    a binding onto existing pieces (speakLine, brain, translate, storeMemory),
  //    not a rebuild. ──────────────────────────────────────────────────────────
  const NARRATE = {
    'mail.inbox': 'Checking your mail', 'mail.readBody': 'Reading the message',
    'calendar.events': 'Checking your calendar', 'web.search': 'Searching the web',
    'web.fetch': 'Reading that page', 'text.compose': 'Drafting that',
    'file.search': 'Searching your files', 'file.read': 'Reading that file',
    'gex131.metrics': 'Checking the server', 'memory.query': 'Looking that up',
  };
  let agentRun = null;     // { goal, lang, total, items:[] } for the active run
  let narrating = false;
  async function narrate(line) {
    if (!line || narrating || confirmInFlight) return;  // never talk over the gate or itself
    narrating = true;
    try { await speakLine(line); } catch (_) {}
    narrating = false;
  }

  async function handleAgentProgress(ev) {
    try {
      if (ev.type === 'plan:start') {
        updateLanguage(ev.goal || '');                  // detect Dutch/French/English from the goal
        agentRun = { goal: ev.goal || '', lang: currentLanguage, total: ev.steps || 0, items: [] };
        brain.setState('thinking'); brain.pulse && brain.pulse(50);
        return;
      }
      if (!agentRun) return;
      if (ev.type === 'step:start') {
        brain.pulse && brain.pulse(40);                 // one cascade per step → thinking→acting
        if (agentRun.total > 1 && ev.side_effect === 'read') {  // brief, multi-step only, reads only
          narrate(NARRATE[ev.tool] || ev.description || 'Working on it');
        }
        return;
      }
      if (ev.type === 'step:finish') { agentRun.items.push({ tool: ev.tool, ok: true, output: ev.output }); brain.pulse && brain.pulse(18); return; }
      if (ev.type === 'step:skipped') { agentRun.items.push({ tool: ev.tool, skipped: true, reason: ev.reason }); return; }
      if (ev.type === 'step:error')  { agentRun.items.push({ tool: ev.tool, ok: false, error: ev.error }); return; }
      if (ev.type === 'plan:finish') { const run = agentRun; agentRun = null; await deliverAgentResult(run, ev); return; }
    } catch (e) { console.warn('[agent:progress] handler error', e); }
  }

  async function deliverAgentResult(run, ev) {
    for (let w = 0; narrating && w < 40; w++) await new Promise((r) => setTimeout(r, 50)); // let narration finish
    let english;
    if (ev.aborted) english = `I couldn't finish that — ${ev.haltReason || 'no available tool could complete it'}.`;
    else english = await summarizeRun(run);
    let line = english;
    try { if (run.lang && run.lang !== 'english') line = await translate(english, run.lang); } catch (_) {}
    emitModel('system');
    try { await speakLine(line); } catch (_) {}
    restOrRearm(); // resting state (watching-aware visual); re-opens the mic in always-listen
    if (qdrantReady) {
      const tools = run.items.map((i) => i.tool).join(', ');
      storeMemory(`Agent run — goal: "${run.goal}". Result: ${english} (tools: ${tools})`,
        cfg.ollamaUrl, { type: 'agent_run', goal: run.goal }).catch(() => {});
    }
  }

  async function summarizeRun(run) {
    const facts = run.items.map((i) =>
      `${i.tool}: ${i.skipped ? 'skipped' : i.ok ? ('ok ' + String(i.output || '').slice(0, 240)) : ('failed ' + (i.error || ''))}`
    ).join('\n') || 'nothing ran';
    try {
      const r = await fetch(`${cfg.ollamaUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.ollamaModelFast, stream: false, options: { temperature: 0.3 },
          messages: [
            { role: 'system', content: 'You are Hannibal. In ONE or TWO short spoken sentences, tell Fred the result of his request from what happened. Be concrete — use numbers/names from the data. No preamble, no markdown.' },
            { role: 'user', content: `Request: ${run.goal}\n\nWhat happened:\n${facts}` },
          ],
        }),
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json();
      return (j.message?.content || '').trim() || 'Done.';
    } catch (_) { return 'Done.'; }
  }

  if (window.hannibal && window.hannibal.onAgentProgress) {
    window.hannibal.onAgentProgress(handleAgentProgress);
  }

  // ── STAGE 7: CONTINUOUS AWARENESS — speak gate, memory, brain, indicator. ──
  // The cheap gates (hash → OCR → struggle math) and the one vision call live in
  // main. This end owns the decision to actually SPEAK — behind the same overlap
  // guards as Stage 6 — plus the Qdrant memory write and brain reflection.
  const URGENCY_RANK = { low: 1, medium: 2, high: 3 };

  // ══ PHASE D — AUTONOMOUS SPEECH ARBITER (fusion) ═══════════════════════════
  // The SINGLE decision point for whether Hannibal says anything unprompted, across
  // ALL modalities — camera presence remarks (companionship) + screen-struggle help
  // offers (actionable). Silence-biased. It fuses a small belief of "what's happening
  // right now" (is Fred talking? is he heads-down working on screen? did he just
  // speak?) so the two autonomous speakers never race and stay contextually grounded,
  // and it enforces ONE global rate-limit. Pure decision lives in arbiterDecide()
  // (top-level, unit-tested); this wrapper supplies live state + does the speaking.
  const ARB = {
    gapMs:          cfg.arbiterGapMs || 30000,
    preemptMs:      cfg.arbiterPreemptMs || 6000,
    focusMs:        cfg.arbiterFocusMs || 20000,
    conversationMs: cfg.arbiterConversationMs || 12000,
  };
  const PRIORITY = { camera: 1, screen: 2 }; // screen-help (actionable) outranks camera chit-chat
  let lastAutonomousTs = 0;
  let lastAutonomousPriority = 0;
  let lastUserSpeakTs = 0;
  let screenBelief = { working: false, appClass: '', score: 0, ts: 0 };

  // Fuse a screen-awareness tick into the "is Fred heads-down working?" belief.
  function noteScreenTick(tick) {
    if (!tick) return;
    const headsDown = tick.appClass === 'code_editor' || tick.appClass === 'terminal';
    screenBelief = { working: headsDown, appClass: tick.appClass || '', score: tick.score || 0, ts: Date.now() };
  }

  // candidate = { source:'camera'|'screen', text, priority, translate }. Returns true if it spoke.
  async function arbitrate(candidate) {
    const state = {
      phase, restfulListen, confirmInFlight, narrating, speaking, autonomousSpeaking,
      vadHeardThisTurn, now: Date.now(),
      lastAutonomousTs, lastAutonomousPriority, lastUserSpeakTs, screenBelief,
    };
    const d = arbiterDecide(state, candidate, ARB);
    if (!d.speak) { console.log(`[arbiter] withhold ${candidate.source} (${d.reason}): "${String(candidate.text).slice(0, 60)}"`); return false; }
    lastAutonomousTs = state.now; lastAutonomousPriority = candidate.priority;
    let line = candidate.text;
    if (candidate.translate && currentLanguage && currentLanguage !== 'english') {
      try { line = await translate(line, currentLanguage); } catch (_) {}
    }
    emitModel('system');
    console.log(`[arbiter] SPEAK ${candidate.source} (prio ${candidate.priority}): "${line}"`);
    await speakAutonomous(line);
    return true;
  }

  async function startWatching() {
    emitModel('system');
    let r; try { r = await window.hannibal.awarenessStart(); } catch (_) { r = { ok: false }; }
    if (r && r.ok) {
      try { const c = await window.hannibal.awarenessConfig(); if (c && c.speakUrgency) awarenessUrgencyThreshold = c.speakUrgency; } catch (_) {}
      await speakLine("I'm watching your screen now. I'll stay quiet unless you seem stuck.");
    } else {
      await speakLine(`I couldn't start watching${r && r.error ? ' — ' + r.error : ''}.`);
    }
    restOrRearm();   // always-listen: reopen the mic (else idle, waiting for wake)
  }

  async function stopWatching() {
    emitModel('system');
    try { await window.hannibal.awarenessStop(); } catch (_) {}
    await speakLine("Okay — I've stopped watching your screen.");
    restOrRearm();   // always-listen: reopen the mic (else idle, waiting for wake)
  }

  async function handleAwarenessObservation(obs) {
    if (!obs) return;
    brain.pulse && brain.pulse(30);                           // notable detected → brief cascade

    // Log EVERY notable observation to memory — even unspoken ones build context.
    if (qdrantReady) {
      const mem = `Awareness: while Fred was in ${obs.app || 'an app'} (${obs.appClass || 'general'}), `
        + `Hannibal noticed he seemed stuck — ${obs.what || 'no detail'}.`;
      storeMemory(mem, cfg.ollamaUrl, {
        type: 'awareness', app: obs.app, urgency: obs.urgency, struggle: obs.score,
        timestamp: new Date(obs.ts || Date.now()).toISOString(),
      }).catch(() => {});
    }

    // Urgency gate stays here (awareness-specific): below threshold → logged to
    // memory only, never voiced. Above → hand to the SHARED arbiter, which owns the
    // overlap guards, cross-modal veto, and global rate-limit across both speakers.
    const rank = URGENCY_RANK[obs.urgency] || 2;
    if (rank < (URGENCY_RANK[awarenessUrgencyThreshold] || 2)) {
      console.log(`[awareness] LOGGED (urgency ${obs.urgency} < ${awarenessUrgencyThreshold}): "${obs.what}"`);
      return;
    }
    const line = obs.offer || obs.what || 'You seem stuck — want a hand?';
    // screen help is actionable → higher priority; translatable to Fred's language.
    await arbitrate({ source: 'screen', priority: PRIORITY.screen, text: line, translate: true });
  }

  if (window.hannibal && window.hannibal.onAwarenessState) {
    window.hannibal.onAwarenessState((s) => {
      watchingActive = !!(s && s.watching);
      if (phase === 'idle') setPhase('idle');               // reconcile the resting brain state now
      try { onWatching && onWatching(watchingActive); } catch (_) {}
    });
  }
  if (window.hannibal && window.hannibal.onAwarenessObservation) {
    window.hannibal.onAwarenessObservation((obs) => {
      handleAwarenessObservation(obs).catch((e) => console.warn('[awareness] obs handler', e));
    });
  }
  // Feed per-changed-frame screen telemetry into the arbiter's "is Fred working?"
  // belief (used to veto camera chit-chat while he's heads-down). Cheap, no speech.
  if (window.hannibal && window.hannibal.onAwarenessTick) {
    window.hannibal.onAwarenessTick((tick) => noteScreenTick(tick));
  }

  // ── PRESENCE LOOP — autonomous spontaneous remarks (English) ────────────────
  // The main-side loop already rate-limits and respects mute; here we reuse the
  // SAME overlap guard as awareness so a remark never talks over Fred, the
  // confirm gate, or an in-progress utterance. Remarks are English by design —
  // NOT translated. main-side is the authority on mute; this is a second guard.
  let presenceMuted = false, presenceSleeping = false, presenceRunning = false;

  // STAP 3 — spoken/typed mute + sleep/wake control of the presence loop.
  async function handlePresence(cmd) {
    emitModel('system');
    let r; try { r = await window.hannibal.presenceControl(cmd.action); } catch (_) { r = { ok: false }; }
    // Speak a short confirmation (a direct reply, not an autonomous remark, so it
    // ignores the mute state). Kept minimal so "shut up" gets a terse acknowledgement.
    const say = cmd.speak || (r && r.ok ? 'Okay.' : "I couldn't do that.");
    await speakLine(say);
    setPhase('idle');
    startListening({ conversation: true });
  }

  async function handlePresenceRemark(r) {
    if (!r || !r.text) return;
    if (presenceMuted || presenceSleeping) { console.log(`[presence] withheld (muted/sleeping): "${r.text}"`); return; }
    brain.pulse && brain.pulse(25);   // "noticed something" cue (whether or not it ends up spoken)
    // Camera remark = companionship chit-chat → lower priority; English, NOT
    // translated. The shared arbiter applies the overlap guards, the heads-down /
    // in-conversation veto, and the global rate-limit.
    await arbitrate({ source: 'camera', priority: PRIORITY.camera, text: r.text, translate: false });
  }
  if (window.hannibal && window.hannibal.onPresenceState) {
    window.hannibal.onPresenceState((s) => {
      presenceMuted = !!(s && s.muted); presenceSleeping = !!(s && s.sleeping); presenceRunning = !!(s && s.running);
    });
  }
  // ── PROACTIVE (morning brief) — main's scheduler says a brief is due. Deliver
  // it only at a quiet moment (never over Fred, a reply, the confirmation gate,
  // teach mode, or while presence is muted/asleep), then report back: main marks
  // the day done only when the brief was actually spoken.
  const isQuiet = () => !speaking && !playingOne && !confirmInFlight && !autonomousSpeaking && !chatTurnActive
    && !narrating && !teachState && !presenceMuted && !presenceSleeping
    && (phase === 'idle' || (continuousListen && restfulListen && phase === 'listening'));
  let proactiveBusy = false;
  async function runProactive(job) {
    if (!job || !['morning-brief', 'nudge'].includes(job.kind)) return;
    if (proactiveBusy) { if (job.kind === 'nudge') window.hannibal.proactiveDone({ kind: 'nudge', id: job.id, ok: false }).catch(() => {}); return; }
    proactiveBusy = true;
    let ok = false;
    let briefText = '';
    try {
      for (let w = 0; !isQuiet() && w < 600; w++) await new Promise((r) => setTimeout(r, 1000)); // ≤10 min
      if (!isQuiet()) { console.log('[proactive] never got a quiet moment — main will retry'); return; }
      console.log(`[proactive] delivering ${job.kind === 'nudge' ? 'a nudge' : 'morning brief'}`);
      if (phase === 'listening') abortListening();   // drop the open resting turn (no STT)
      if (cfg.claudeEnabled && cfg.claudeTools) {
        setPhase('thinking');
        emitModel(cfg.claudeModel);
        const reply = await streamChatAndSpeak({
          model: cfg.ollamaModelFast || cfg.ollamaModel,
          messages: [{ role: 'system', content: ctxPreamble() + SYSTEM_PROMPT }, { role: 'user', content: job.prompt }],
          claude: {
            system: SYSTEM_PROMPT + ' Notes about the current situation and any relevant memories arrive as system messages during the conversation.',
            context: ctxPreamble(),
            user: job.prompt,
          },
        });
        ok = !!(reply && reply.trim());
        if (ok) briefText = reply.trim();
        startListening({ conversation: true });       // he can answer the brief straight away
      } else if (job.kind === 'morning-brief') {
        const res = await window.hannibal.runSkill('morning-brief', { language: currentLanguage });
        ok = !!(res && res.ok);
      }
    } catch (e) {
      console.warn('[proactive] brief failed', e);
    } finally {
      proactiveBusy = false;
      try { await window.hannibal.proactiveDone({ kind: job.kind, day: job.day, id: job.id, ok, text: briefText }); } catch (_) {}
    }
  }
  if (window.hannibal && window.hannibal.onProactiveRun) {
    window.hannibal.onProactiveRun((job) => { runProactive(job).catch((e) => console.warn('[proactive] handler', e)); });
  }
  // Claude set or cancelled a reminder in main → pick up the new list.
  if (window.hannibal && window.hannibal.onNotesChanged) {
    window.hannibal.onNotesChanged(() => { loadNotes().catch(() => {}); });   // so a voice note never overwrites Claude's
  }
  if (window.hannibal && window.hannibal.onRemindersChanged) {
    window.hannibal.onRemindersChanged(() => { loadReminders().catch(() => {}); });
  }

  if (window.hannibal && window.hannibal.onPresenceRemark) {
    window.hannibal.onPresenceRemark((r) => { handlePresenceRemark(r).catch((e) => console.warn('[presence] remark handler', e)); });
  }
  if (window.hannibal && window.hannibal.onPresenceAction) {
    window.hannibal.onPresenceAction((a) => { if (a && a.refused) console.warn(`[presence] REFUSED autonomous ${a.tool}: ${a.reason}`); });
  }

  // ── Streaming silero VAD events — the primary end-of-utterance decision. ──
  function handleVad(ev) {
    if (!ev) return;
    if (ev.type === 'error') {
      vadReady = false;
      // Do NOT hand control to the level detector — silero stays the authority and
      // auto-restarts. Turns during the gap close quietly (never transcribe music).
      console.warn('[voice] silero sidecar down (auto-restarting)' + (vadAuthority ? ' — turns will wait for it, not fall back to level' : '') + ':', ev.error || '');
      return;
    }
    // ANY positive signal (ready OR a speech event) proves silero is alive → latch
    // it as the authority. The one-shot 'ready' can be missed (e.g. it fired before
    // this listener subscribed, or before a renderer reload), so we must NOT depend
    // on it alone — otherwise speech turns work (START/END caught here) while
    // authority never latches and no-speech turns wrongly fall to the level branch.
    if (ev.type === 'ready' || ev.type === 'start' || ev.type === 'end') {
      vadReady = true;
      if (!vadAuthority) { vadAuthority = true; console.log('[voice] silero VAD is now the AUTHORITY for end-of-utterance on EVERY turn'); }
    }
    if (ev.type === 'ready') return;
    // Speech events only steer a turn while one is actually open — never Hannibal's
    // own TTS or ambient talk while idle. (Same mic-exclusion principle as the gate.)
    if (!vadTurnActive || phase !== 'listening' || confirmInFlight) return;
    if (ev.type === 'start') { vadHeardThisTurn = true; vadSpeechStartAt = performance.now(); restfulListen = false; console.log('[voice] silero: speech start'); return; }
    if (ev.type === 'end') {
      if (!vadHeardThisTurn) return;            // ignore a stray END before any START this turn
      console.log('[voice] silero: end of utterance — stopping');
      stopListening();
    }
  }
  if (window.hannibal && window.hannibal.onVad) window.hannibal.onVad(handleVad);

  // ── ALWAYS-LISTEN kickoff ───────────────────────────────────────────────────
  // With the flag on, don't wait for "Hey Hannibal": open the mic now and keep it
  // open (each turn re-arms via restOrRearm). The short delay lets calibrateNoise-
  // Floor() finish and lets silero subscribe before the first turn. Idempotent —
  // guards against a race with a wake/gate that already opened the mic.
  if (continuousListen) {
    setTimeout(() => {
      if (confirmInFlight || speaking || phase === 'listening' || phase === 'thinking' || phase === 'speaking') return;
      console.log('[voice] ALWAYS-LISTEN on — opening mic continuously; no wake word needed (say "go idle" to stand down)');
      startListening({ conversation: true });
    }, 1500);
  } else {
    console.log('[voice] always-listen OFF — classic wake-word flow ("Hey Hannibal" to start)');
  }

  return {
    startListening,                 // manual trigger (click / key)
    stopListening,
    submitText,                     // quick-action pills / typed input
    setActiveEmail,                 // mail-click in index.html sets "the displayed email"
    getPhase: () => phase,
    startWatching,                  // Stage 7 — UI toggle / voice command share this path
    stopWatching,
    isWatching: () => watchingActive,
  };
}

// ── SELF-LEARNING ALIAS SYSTEM ──────────────────────────────────────────────
// Single source of truth lives at ~/hannibal-v2/data/aliases.json (loaded via
// main-process IPC because contextBridge isolates this renderer from fs).
// Categories:
//   names    — project + brand + contact names ("rivalis" → "revalis")
//   commands — verb-phrase fixes        ("shot down" → "shut down")
// Both are applied as case-insensitive word-boundary replacements in
// fixTranscript, so every downstream path (parseCommand, classifyIntent,
// agentLoop, respond) sees the same normalized text. New entries are added
// either explicitly ("add alias X for Y") or after a fuzzy-match miss is
// confirmed ("Did you mean X?" → "yes"). loadAliasesFromDisk() runs once on
// initVoice; addAliasAndPersist() updates the in-memory cache AND writes the
// file (no restart needed to pick up new aliases).
let ALIASES = { names: {}, commands: {} };
async function loadAliasesFromDisk() {
  try {
    const r = await window.hannibal.loadAliases();
    if (r && r.ok && r.data) {
      ALIASES = { names: r.data.names || {}, commands: r.data.commands || {} };
      console.log('[aliases] loaded', Object.keys(ALIASES.names).length, 'names,', Object.keys(ALIASES.commands).length, 'commands');
    }
  } catch (e) { console.warn('[aliases] load failed', e); }
}
async function addAliasAndPersist(wrong, right, category) {
  const key = String(wrong || '').toLowerCase().trim();
  const value = String(right || '').trim();
  const cat = category === 'commands' ? 'commands' : 'names';
  if (!key || !value) return false;
  ALIASES[cat][key] = value;
  try {
    const r = await window.hannibal.saveAliases(ALIASES);
    return !!(r && r.ok);
  } catch (e) { console.warn('[aliases] save failed', e); return false; }
}
function applyAliases(text) {
  let t = text;
  // Order: names first, then commands. Doesn't really matter — entries are
  // mutually exclusive by shape — but we keep it stable for predictability.
  for (const cat of ['names', 'commands']) {
    for (const [from, to] of Object.entries(ALIASES[cat] || {})) {
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), to);
    }
  }
  return t;
}

// ── PREFERENCES ─────────────────────────────────────────────────────────────
// Disk-backed learning state. PREFERENCES is shape-stable:
//   response_length: {default, overrides:{<taskType>:'short'|'detailed'|'normal'}}
//   model_preferences: {<taskType>:'fast'|'deep'|'system'}
//   time_preferences: {before_08, after_22, work_hours}
//   corrections: [{type,value,taskType,phrase,ts}, …]  ← append-only audit
//   interruption_counts: {<taskType>:N}
//   model_switch_counts: {<taskType>:N}
// Application of these to response generation is its own future turn; this
// turn just records the signals so the data exists.
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
let PREFERENCES = JSON.parse(JSON.stringify(BOOTSTRAP_PREFS));
async function loadPreferencesFromDisk() {
  try {
    const r = await window.hannibal.loadPreferences();
    if (r && r.ok && r.data) {
      PREFERENCES = {
        ...JSON.parse(JSON.stringify(BOOTSTRAP_PREFS)),
        ...r.data,
        response_length: { ...BOOTSTRAP_PREFS.response_length, ...(r.data.response_length || {}) },
      };
      console.log('[prefs] loaded',
        Object.keys(PREFERENCES.response_length.overrides || {}).length, 'length overrides,',
        Object.keys(PREFERENCES.model_preferences || {}).length, 'model prefs,',
        (PREFERENCES.corrections || []).length, 'corrections');
    }
  } catch (e) { console.warn('[prefs] load failed', e); }
}
async function persistPreferences() {
  try { await window.hannibal.savePreferences(PREFERENCES); }
  catch (e) { console.warn('[prefs] save failed', e); }
}

// Map a dispatched command to a stable task-type string. Used as the key for
// per-task preference overrides and the various tally buckets. Keeps the
// taxonomy small so 3-of-same-type thresholds fire on realistic frequencies.
function taskTypeFromCmd(cmd) {
  if (!cmd) return 'chat';
  if (cmd.kind === 'mail') return cmd.mode === 'plural' ? 'email_summary' : 'email_read';
  if (cmd.kind === 'briefing') return 'briefing';
  if (cmd.kind === 'vision') return cmd.mode === 'camera' ? 'vision_camera' : 'vision_screen';
  if (cmd.kind === 'camera') return cmd.action === 'look' ? 'camera_look' : 'camera_control';
  if (cmd.kind === 'presence') return 'presence_control';
  if (cmd.kind === 'file-search' || cmd.kind === 'file-search-again') return 'file_search';
  if (cmd.kind === 'file-recent') return 'file_recent';
  if (cmd.kind === 'file-read') return 'file_read';
  if (cmd.kind === 'file-open') return 'file_open';
  if (cmd.kind === 'behavior-recent') return 'behavior_query';
  if (cmd.kind === 'preferences-read') return 'preferences_query';
  if (cmd.kind === 'skill') return `skill_${cmd.skill && cmd.skill.id ? cmd.skill.id : 'unknown'}`;
  if (cmd.kind === 'skill-teach' || cmd.kind === 'skill-list' || cmd.kind === 'skill-forget') return 'skill_management';
  if (cmd.kind === 'web-read') return 'web_read';
  if (cmd.kind === 'web-search') return 'web_search';
  if (cmd.kind === 'world') return `world_${String(cmd.topic || 'read').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'read'}`;
  if (cmd.kind === 'site-down') return 'site_down';
  if (cmd.kind && cmd.kind.startsWith('reminder-')) return 'reminder';
  if (cmd.kind && cmd.kind.startsWith('timer-')) return 'timer';
  if (cmd.kind && cmd.kind.startsWith('note-')) return 'note';
  if (cmd.kind === 'translate') return 'translate';
  if (cmd.kind === 'clipboard-copy' || cmd.kind === 'clipboard-paste') return 'clipboard';
  if (cmd.kind === 'browser') return 'browser';
  if (cmd.kind === 'mac' && /^open-app/.test(cmd.action)) return 'open_app';
  if (cmd.kind === 'mac') return 'system';
  return cmd.kind || 'chat';
}

// ── PERSONALITY + MOOD ──────────────────────────────────────────────────────
// data/personality.json is mostly STATIC reference (the user can edit core
// traits + relationship by hand). At runtime we update emotional_state and
// append to mood_history when Fred's detected mood transitions. Detection is
// pure-heuristic — no LLM call — so it's cheap to run on every utterance.
let PERSONALITY = null;
async function loadPersonalityFromDisk() {
  try {
    const r = await window.hannibal.loadPersonality();
    if (r && r.ok && r.data) {
      PERSONALITY = r.data;
      console.log('[personality] loaded —', (PERSONALITY.mood_history || []).length, 'mood entries');
    }
  } catch (e) { console.warn('[personality] load failed', e); }
}
async function savePersonality() {
  if (!PERSONALITY) return;
  try { await window.hannibal.savePersonality(PERSONALITY); }
  catch (e) { console.warn('[personality] save failed', e); }
}

// Heuristic mood classification. Inputs:
//   text — the spoken/typed utterance
//   ctx  — { hour, recentRapid:N, awaySec:N } shape from caller
// Returns one of: frustrated | excited | tired | relaxed | focused | in_the_zone | neutral.
// Order matters — "fucking awesome" hits excited before frustrated; tone wins
// over hour-of-day. "in_the_zone" trumps everything else when rapid commands
// are detected (Fred is mid-flow, don't interrupt with small talk).
function detectMood(text, ctx) {
  const t = String(text || '').toLowerCase();
  const ZONE_THRESHOLD = 3; // 3+ commands in the rapid window
  if (ctx && ctx.recentRapid >= ZONE_THRESHOLD) return 'in_the_zone';
  // Positive intensifiers — must come before the generic profanity check.
  if (/\b(?:fucking (?:great|awesome|amazing|nice|brilliant|incredible|love (?:it|this)|good)|finally|nailed it|yes!|let'?s go|haha+|hahaha|lol+|hell yeah|fantastic|brilliant)\b/.test(t)) return 'excited';
  // Frustration markers — profanity NOT preceded by a positive cue, or explicit complaints.
  if (/\b(?:fuck(?:ing|ers?)?|shit|damn it|piece of shit|stupid|broken|crap|bullshit|why isn'?t|why doesn'?t|wtf|godd?ammit)\b/.test(t)) return 'frustrated';
  // Tired — late hour OR explicit fatigue.
  if ((ctx && (ctx.hour >= 23 || ctx.hour < 5)) || /\b(?:tired|exhausted|sleepy|knackered|wiped|drained)\b/.test(t)) return 'tired';
  // Relaxed — polite, conversational length.
  if (/\b(?:please|thanks|cheers|appreciate|kindly)\b/.test(t) && t.length > 15) return 'relaxed';
  // Focused — short, imperative, no chitchat. Fits most quick commands.
  if (t.length < 30 && !/\?/.test(t)) return 'focused';
  return 'neutral';
}

// ── USER-TAUGHT SKILLS ──────────────────────────────────────────────────────
// data/skills.json is Hannibal's runtime-extensible skill library. Each skill
// has a list of trigger phrases; matchSkill(text) tries exact-substring first
// (fast and reliable) and falls back to a tokenized fuzzy match at a high
// threshold (0.85) — false matches here would execute shell commands, so we
// err on the side of letting things pass through to the LLM. saveSkillsToDisk
// persists the whole array; cheap because the file is small.
let SKILLS = [];
async function loadSkillsFromDisk() {
  try {
    const r = await window.hannibal.loadSkills();
    if (r && r.ok) {
      SKILLS = Array.isArray(r.skills) ? r.skills : [];
      console.log('[skills] loaded', SKILLS.length, 'skill(s)');
    }
  } catch (e) { console.warn('[skills] load failed', e); }
}
async function saveSkillsToDisk() {
  try { await window.hannibal.saveSkills(SKILLS); }
  catch (e) { console.warn('[skills] save failed', e); }
}
function matchSkill(text) {
  if (!SKILLS.length) return null;
  const t = String(text || '').toLowerCase().trim().replace(/[.?!]+$/, '');
  if (!t) return null;
  // Pass 1: exact match or substring on any trigger. The trigger is the
  // user-defined phrase; we accept it if the utterance equals it, OR the
  // utterance starts with it (so "check vercel for me" still matches "check
  // vercel"). Substring-at-start avoids matching "uncheck vercel".
  for (const skill of SKILLS) {
    for (const trig of skill.trigger || []) {
      const tl = String(trig).toLowerCase().trim();
      if (!tl) continue;
      if (t === tl) return { skill, score: 1, exact: true };
      if (t.startsWith(tl + ' ') || t.endsWith(' ' + tl)) return { skill, score: 0.95, exact: false };
    }
  }
  // Pass 2: fuzzy match — only if the score is very high (>=0.85). Skill
  // execution is irreversible (shell side-effects), so we hold the threshold
  // higher than for the alias-suggestion path (which has explicit Yes/No).
  const all = [];
  for (const skill of SKILLS) {
    for (const trig of skill.trigger || []) all.push({ trig, skill });
  }
  const hit = bestMatch(t, all.map((x) => x.trig), 0.85);
  if (hit) {
    const found = all.find((x) => x.trig.toLowerCase() === hit.match.toLowerCase());
    if (found) return { skill: found.skill, score: hit.score, exact: false };
  }
  return null;
}

// ── CONTEXT AWARENESS ───────────────────────────────────────────────────────
// Pure functions that summarize "what time / day / mode is it right now". The
// outputs feed two places: (a) the wake greeting picks a phrasing based on
// period + day flags; (b) every LLM system prompt is prefixed with a short
// preamble so the model can adapt without needing hardcoded rules in each
// call site. Keep the preamble TIGHT — model attention is the budget.
const PERIODS = [
  { start: 5,  end: 8,  name: 'early_morning' },
  { start: 8,  end: 12, name: 'morning' },
  { start: 12, end: 17, name: 'afternoon' },
  { start: 17, end: 21, name: 'evening' },
  { start: 21, end: 25, name: 'night' },           // 21:00–01:00 (wraps; handled below)
  { start: 1,  end: 5,  name: 'late_night' },      // 01:00–05:00
];
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function getContext(now = new Date()) {
  const hour = now.getHours();
  const minute = now.getMinutes();
  let period = 'afternoon';
  if (hour >= 5 && hour < 8) period = 'early_morning';
  else if (hour >= 8 && hour < 12) period = 'morning';
  else if (hour >= 12 && hour < 17) period = 'afternoon';
  else if (hour >= 17 && hour < 21) period = 'evening';
  else if (hour >= 21 || hour < 1) period = 'night';
  else period = 'late_night';
  const dayOfWeek = DAY_NAMES[now.getDay()];
  const isWeekend = dayOfWeek === 'saturday' || dayOfWeek === 'sunday';
  const isWorkHours = !isWeekend && hour >= 9 && hour < 18;
  const isMondayMorning = dayOfWeek === 'monday' && (period === 'early_morning' || period === 'morning');
  const isFridayEvening = dayOfWeek === 'friday' && period === 'evening';
  const pad = (n) => String(n).padStart(2, '0');
  return {
    hour, minute, period, dayOfWeek, isWeekend, isWorkHours, isMondayMorning, isFridayEvening,
    timeStr: `${pad(hour)}:${pad(minute)}`,
  };
}

// Classify the last few task types into a high-level activity mode. Dev mode
// is anything file/code related; admin is email/calendar/briefing/log queries;
// otherwise general. Threshold: 3-of-5 needed to flip from general — avoids
// flapping on every other turn.
function activityModeFromTasks(tasks) {
  if (!tasks || tasks.length === 0) return 'general';
  const counts = { dev: 0, admin: 0, general: 0 };
  for (const t of tasks) {
    if (!t) continue;
    if (/^file_/.test(t)) counts.dev++;
    else if (/^(email_|briefing|behavior_query|preferences_query)/.test(t)) counts.admin++;
    else counts.general++;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return ranked[0][1] >= 3 ? ranked[0][0] : 'general';
}

// One-line context preamble prepended to every LLM system prompt. Format
// includes day+time, period+weekend flag, current activity mode, and a brief
// tone hint pulled from the time_preferences in data/preferences.json (so the
// preamble actually reflects Fred's learned defaults, not just hardcoded
// rules). Stays under ~200 chars so it doesn't bloat the prompt.
function buildContextPreamble(ctx, mode, prefs) {
  const c = ctx || getContext();
  const m = mode || 'general';
  const segs = [`Context: ${c.dayOfWeek} ${c.timeStr} (${c.period}${c.isWeekend ? ', weekend' : ''}, ${m} mode).`];
  // Tone/length hints from time_preferences. Quiet hours = brief+calm.
  const tp = (prefs && prefs.time_preferences) || {};
  if (c.hour < 8 && tp.before_08) segs.push(`Early morning — be ${tp.before_08.length || 'brief'} and ${tp.before_08.tone || 'calm'}.`);
  else if (c.hour >= 22 && tp.after_22) segs.push(`It's late — be ${tp.after_22.length || 'brief'} and ${tp.after_22.tone || 'calm'}.`);
  else if (c.isWorkHours && tp.work_hours) segs.push(`Work hours — ${tp.work_hours.tone || 'energetic'}, ${tp.work_hours.length || 'normal'} responses.`);
  return segs.join(' ');
}

// Greeting line on wake. Time-of-day + day-of-week flavor. If Fred has been
// away for a long stretch, prepend a brief "welcome back" sentiment so the
// time greeting is the LAST thing he hears (more natural to react to).
function buildGreeting(ctx, awayMs) {
  const c = ctx || getContext();
  let core;
  if (c.isMondayMorning)        core = "Good morning Fred. New week — want your briefing?";
  else if (c.isFridayEvening)   core = "Happy Friday Fred.";
  else if (c.period === 'early_morning') core = "Good morning Fred.";
  else if (c.period === 'morning')       core = "Morning Fred. Ready to work.";
  else if (c.period === 'afternoon')     core = "Hey Fred.";
  else if (c.period === 'evening')       core = "Hey Fred. Still at it?";
  else                                   core = "Hey Fred.";   // night / late_night
  let prefix = '';
  let suffix = '';
  if (awayMs && awayMs >= 2 * 60 * 60 * 1000) {
    const h = Math.round(awayMs / (60 * 60 * 1000));
    prefix = `Welcome back. You were away for ${h > 1 ? `${h} hours` : 'about an hour'}. `;
    // Offer catch-up only on real returns (≥2h gap). Keep it light — one
    // question, not a sales pitch.
    suffix = ' Want a quick catch-up?';
  }
  return prefix + core + suffix;
}

// ── TIME-PHRASE PARSER ──────────────────────────────────────────────────────
// Shared by reminders + timers. Accepts "in N (seconds|minutes|hours)" and
// "at HH" / "at HH:MM" (optionally prefixed with "tomorrow"). Returns the
// absolute trigger timestamp in ms, or null if nothing matches. Conservative
// on purpose — better to fail and let the user rephrase than misread a time.
function parseTimePhrase(text) {
  const t = String(text || '').toLowerCase().trim();
  // "in N (sec|min|hour)s"
  let m = t.match(/\bin\s+(?:a\s+|an\s+)?(\d+|a|an|half)\s*(?:and\s+a\s+half\s+)?(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs|day|days)\b/);
  if (m) {
    const num = m[1] === 'a' || m[1] === 'an' ? 1 : m[1] === 'half' ? 0.5 : parseInt(m[1], 10);
    const halfBonus = /and\s+a\s+half/.test(t) ? 0.5 : 0;
    const unit = m[2];
    const seconds =
      /sec/.test(unit) ? num + halfBonus :
      /min/.test(unit) ? (num + halfBonus) * 60 :
      /hour|hr/.test(unit) ? (num + halfBonus) * 3600 :
      /day/.test(unit) ? num * 86400 : 0;
    if (seconds > 0) return { ts: Date.now() + seconds * 1000, ms: seconds * 1000 };
  }
  // Bare "N (sec|min|hour)" — Whisper drops "in" frequently
  m = t.match(/^(?:set\s+(?:a\s+)?timer\s+(?:for\s+)?)?(\d+)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)\b/);
  if (m) {
    const num = parseInt(m[1], 10);
    const unit = m[2];
    const seconds = /sec/.test(unit) ? num : /min/.test(unit) ? num * 60 : num * 3600;
    if (seconds > 0) return { ts: Date.now() + seconds * 1000, ms: seconds * 1000 };
  }
  // "(today|tomorrow)? at HH(:MM)?(am|pm)?"
  m = t.match(/\b(tomorrow|today)?\s*at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (m) {
    let h = parseInt(m[2], 10);
    const min = m[3] ? parseInt(m[3], 10) : 0;
    const ampm = m[4];
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    const d = new Date();
    d.setHours(h, min, 0, 0);
    const isTomorrow = m[1] === 'tomorrow';
    if (isTomorrow || d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return { ts: d.getTime(), ms: d.getTime() - Date.now() };
  }
  return null;
}

// ── BEHAVIOR LOG ────────────────────────────────────────────────────────────
// Fire-and-forget logger for every successful command. The renderer doesn't
// care about the result — backend writes data/behavior-log.json. We filter
// out confirmations (yes/no after a "Did you mean…?" prompt), idle/cancel
// utterances (those mean stop, not "do something"), and meta-commands like
// "add alias…" because those teach Hannibal rather than expressing routine.
const NON_BEHAVIOR_RE = /^(?:yes|yeah|yep|yup|ja|jawel|correct|right|exactly|do it|sure|ok|okay|go ahead|affirmative|no|nope|nah|nee|not (?:that|it)|wrong|cancel|forget it|never ?mind|stop|idle|go idle|that'?s all)\.?$/i;
const META_BEHAVIOR_RE = /^(?:add|save|create|remember|store)\s+(?:a\s+)?(?:new\s+)?(?:contact\s+)?alias\b/i;
// Correction phrases (length, language, model, vague-redo). Mirror of the
// patterns in parseCommand — these utterances are FEEDBACK on the prior turn
// and shouldn't appear in the behavior log as if they were routine commands.
const CORRECTION_RE = /^(?:(?:be )?(?:shorter|too long|more brief|briefer|cut it short|be brief|less)|(?:longer|too short|more detail|more context|more info|elaborate|expand|in more detail|tell me more)|(?:speak |reply |answer |respond )?in\s+(?:dutch|nederlands|english|engels|spanish|french|german|portuguese|italian)(?:\s+please)?|(?:use|switch to|try)\s+(?:the\s+)?(?:big|deep|heavy|large|powerful|smart|70b|llama|fast|small|quick|light)\s+(?:model|llm|brain)?|think harder|be (?:quick|fast|quicker|faster)|(?:no,? )?(?:that(?:'?s| ?is) (?:wrong|not (?:right|it|correct))|niet zo|that wasn'?t (?:right|it)|incorrect|wrong))\.?$/i;
function shouldLogCommand(text) {
  const t = String(text || '').trim().replace(/[.?!]+$/, '');
  if (!t) return false;
  if (NON_BEHAVIOR_RE.test(t)) return false;
  if (META_BEHAVIOR_RE.test(t)) return false;
  if (CORRECTION_RE.test(t)) return false;
  // Introspective queries about the log itself are meta — don't log them
  // (otherwise asking "what did I do today" pollutes "what did I do today").
  if (/^(?:show me|list|read me|tell me|what)\b.*\bcommands?\b/i.test(t)) return false;
  if (/^what (?:did i|have i)\s+(?:do|done|ask|say)\b/i.test(t)) return false;
  // "what have you learned" / "show me my preferences" — introspective queries
  // about the prefs file. Same rationale as the behavior-log queries above:
  // asking ABOUT something isn't doing it.
  if (/\b(?:learn(?:ed)?|preferences?|prefs)\b/i.test(t)
      && /^(?:what|show me|list|tell me|read me|my)\b/i.test(t)) return false;
  // Skill management is meta — not a routine command worth pattern-detecting.
  if (/^(?:teach (?:me )?(?:a |something )?(?:new )?(?:skill|something)|list (?:my |your )?skills|what skills|show (?:me )?(?:your |my )?skills|(?:forget|delete|remove|drop)\s+(?:the\s+)?.+\s+skill)\b/i.test(t)) return false;
  return true;
}
function logBehavior(command) {
  if (!shouldLogCommand(command)) return;
  // Fire-and-forget — never block the next turn on disk I/O.
  try { window.hannibal.logBehavior(command); } catch (_) {}
}

// ── FUZZY MATCH ─────────────────────────────────────────────────────────────
// Two-row Levenshtein, normalized to a similarity score in [0,1]. Used when
// a file-search (and later: app-open, whatsapp-send) misses outright — we
// look for a close candidate and ask the user to confirm.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}
function similarity(a, b) {
  if (!a || !b) return 0;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  const max = Math.max(x.length, y.length);
  return max === 0 ? 1 : 1 - levenshtein(x, y) / max;
}
function bestMatch(query, candidates, threshold) {
  let bestScore = 0;
  let bestCandidate = null;
  for (const c of candidates) {
    // Score against the whole candidate AND against each whitespace-delimited
    // word, then keep the best of the two. This is what makes "Crome" match
    // "Google Chrome" — it'd score 0.23 against the full name but ~0.83
    // against the word "Chrome". The candidate we return is still the FULL
    // string, so when we retry we hand the user the canonical form.
    let score = similarity(query, c);
    for (const word of String(c).split(/[\s\-_/]+/).filter(Boolean)) {
      const ws = similarity(query, word);
      if (ws > score) score = ws;
    }
    if (score > bestScore) { bestScore = score; bestCandidate = c; }
  }
  return bestScore >= (threshold ?? 0.7) ? { match: bestCandidate, score: bestScore } : null;
}

// Enumerate installed .app names (sans extension) under /Applications and
// ~/Applications. Cached on first call — the app catalog doesn't change
// often enough to re-shell on every miss.
let _appCatalog = null;
async function suggestAppMatch(query) {
  if (!_appCatalog) {
    try {
      const r = await window.hannibal.macControl('shell',
        `for d in /Applications "$HOME/Applications"; do
           [ -d "$d" ] && /bin/ls -1 "$d" 2>/dev/null
         done | /usr/bin/grep -i '\\.app$' | /usr/bin/sed 's/\\.app$//' | /usr/bin/sort -u`);
      if (r && r.success && r.data) {
        _appCatalog = r.data.split('\n').map((s) => s.trim()).filter(Boolean);
      } else {
        _appCatalog = [];
      }
    } catch (_) { _appCatalog = []; }
  }
  if (_appCatalog.length === 0) return null;
  const hit = bestMatch(query, _appCatalog, 0.7);
  return hit ? hit.match : null;
}

// Suggest a canonical contact name when WhatsApp says "no chat row matched".
// Candidate pool is the set of canonical alias VALUES from data/aliases.json
// names category — those are the names the user (or bootstrap) has already
// confirmed as real. Dedupe via Set.
function suggestContactMatch(contact) {
  const candidates = [...new Set(Object.values(ALIASES.names || {}))];
  if (candidates.length === 0) return null;
  const hit = bestMatch(contact, candidates, 0.7);
  return hit ? hit.match : null;
}

// Stream Ollama /api/chat (newline-delimited JSON), invoking onToken per chunk.
//
// IMPORTANT — why we don't put a short timeout on /api/chat itself:
// Ollama does NOT send HTTP response headers until it has computed the *first
// token*, i.e. after the full prompt+image evaluation. For vision that encode is
// 20-130s, so `await fetch()` only resolves once generation is already underway.
// The old code aborted the fetch if headers hadn't arrived within 8s (or 45s),
// which meant a perfectly healthy-but-slow vision encode got killed and spoke
// "I can't reach my … model — the connection timed out." That's the bug.
//
// Fix: separate the two questions. "Is the box reachable?" is answered in ms by a
// quick /api/version probe. "Is generation slow?" is expected for vision and must
// NOT be treated as unreachable — so the actual stream gets only a generous hard
// ceiling to guard against a truly wedged socket. connectTimeoutMs (if a caller
// passes one) raises that ceiling for heavy work.
const REACH_TIMEOUT_MS = 4000;       // /api/version probe — "is GEX131 up?"
const STREAM_CEILING_MS = 240000;    // hard cap so a hung socket can't block forever
async function streamOllama(baseUrl, model, messages, onToken, { connectTimeoutMs } = {}) {
  // Reachability probe — fast, and the ONLY thing that should raise a connectivity
  // error. If Tailscale/the box is down this fails in ~4s instead of hanging.
  try {
    await fetch(baseUrl + '/api/version', { signal: AbortSignal.timeout(REACH_TIMEOUT_MS) });
  } catch (_) {
    throw new DOMException('ollama unreachable', 'TimeoutError');
  }

  const ceiling = Math.max(connectTimeoutMs || 0, STREAM_CEILING_MS);
  const res = await fetch(baseUrl + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(ceiling),     // generous — does NOT cut a slow vision encode
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      keep_alive: '24h',
      options: { num_predict: 512, num_ctx: 4096, temperature: 0.7 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();                       // keep last partial line
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const j = JSON.parse(t);
        const tok = j.message && j.message.content;
        if (tok) onToken(tok);
      } catch (_) { /* ignore non-JSON keepalives */ }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── MODEL ROUTER ─────────────────────────────────────────────────────────────
// ── Language detection (heuristic) ──────────────────────────────────────────
// Count function-word markers per language; highest wins; default English.
// Cheap O(n) regex pass over the transcript — runs on every utterance so the
// system prompt always reflects the language Fred just spoke in. ElevenLabs
// Daniel + eleven_multilingual_v2 handles Dutch/French pronunciation natively,
// so no voice/model swap is needed downstream — only the LLM needs the hint.
// Spanish too (Ibiza): same voice, eleven_multilingual_v2 speaks it natively.
const DUTCH_WORDS = /\b(het|een|niet|wat|hoe|kan|wil|moet|voor|maar|ook|nog|wel|naar|bij|deze|geen|zijn|hebben|worden|goed|graag|alsjeblieft|vandaag|morgen)\b/i;
const FRENCH_WORDS = /\b(le|la|les|une|est|pas|pour|que|comment|avec|dans|mais|aussi|faire|cette|sont|peut|tout|bien|merci|aujourd|demain|bonjour)\b/i;
const SPANISH_WORDS = /(?:\b(?:el|los|las|una|es|está|estoy|están|para|pero|también|hoy|mañana|dónde|donde|cuándo|cuando|cómo|qué|tengo|quiero|puedes|hacer|muy|hola|gracias|favor|buenos|buenas|necesito|ahora|aquí|vamos|del)\b|[ñ¿¡])/i;
function detectLanguage(text) {
  const t = String(text || '');
  // Global flags via matchAll-style: use a g-version of the same character class.
  const d = (t.match(new RegExp(DUTCH_WORDS.source, 'gi')) || []).length;
  const f = (t.match(new RegExp(FRENCH_WORDS.source, 'gi')) || []).length;
  const s = (t.match(new RegExp(SPANISH_WORDS.source, 'gi')) || []).length;
  const top = Math.max(d, f, s);
  if (top === 0) return 'english';
  if (s === top && s > d && s > f) return 'spanish';
  if (d > f && d >= s) return 'dutch';
  if (f > d && f >= s) return 'french';
  return 'english';
}

// Classify a turn so trivial chat hits the fast model and only genuinely complex
// requests escalate to the heavy 70b. Conservative: default to 'fast', escalate
// only on clear signals (length, or reasoning/coding/analysis intent).
const HEAVY_INTENT = /\b(code|coding|program|function|script|debug|refactor|algorithm|regex|sql|analy[sz]e|reason|prove|calculate|compute|derive|step[- ]by[- ]step|in detail|explain how|explain why|write (me )?(a|an|the)|draft|compose|summari[sz]e|translate|plan|strategy|compare|pros and cons)\b/i;
function classifyTurn(text) {
  const t = (text || '').trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words >= 25) return 'heavy';            // long ask → reasoning likely
  if (HEAVY_INTENT.test(t)) return 'heavy';   // explicit complex intent
  return 'fast';                              // greetings, small talk, short Qs
}
function routeModel(text, cfg) {
  const fast  = cfg.ollamaModelFast  || cfg.ollamaModel;
  const heavy = cfg.ollamaModelHeavy || cfg.ollamaModel;
  return classifyTurn(text) === 'heavy' ? heavy : fast;
}

// ── COMMAND PARSER (instant-only) ───────────────────────────────────────────
// The agentic core (agentLoop) handles open-ended actions via the LLM. This
// parser now only catches the handful of commands that must be INSTANT — they'd
// be absurd to route through a 20-80s vision turn. Everything else returns null
// and falls through to classifyIntent → agentLoop (action) or respond() (chat).
// Trailing politeness that never changes intent but breaks strict patterns
// like /^open (.+)$/ ("open chrome please" wouldn't match without this).
// Multi-pass so stacks like "open chrome, please, thanks" all peel off. Order
// matters: longer alternatives ("dank je wel") come before shorter prefixes
// ("dank je"), otherwise the shorter wins and leaves a dangling "wel".
const TRAILING_FILLER_RE = /[,\s]+(?:please|thanks|thank you|bedankt|dank je wel|dank je|alstublieft|alstjeblieft|alsjeblieft|graag|if you can|for me|could you|can you|would you)[?.!]*\s*$/i;
function stripFiller(t) {
  let prev;
  do { prev = t; t = t.replace(TRAILING_FILLER_RE, '').trim(); } while (t !== prev);
  return t;
}

function parseCommand(text) {
  let t = text.toLowerCase().trim().replace(/[.?!]+$/, '');
  t = stripFiller(t);

  // ── Add a contact alias on the fly ──────────────────────────────────────
  // "add alias guyan for Gaian" / "remember alias mandi is Mandy" / etc.
  // We match the SHAPE on lowercased `t`, then re-extract from the original
  // (case-preserving) text so the stored value keeps its proper capitalization.
  const ALIAS_RE = /^(?:add|save|create|remember|store)\s+(?:a\s+)?(?:new\s+)?(?:contact\s+)?alias\s+(.+?)\s+(?:for|=|is|as)\s+(.+)$/i;
  if (ALIAS_RE.test(t)) {
    const origNorm = stripFiller(text.trim().replace(/[.?!]+$/, ''));
    const orig = origNorm.match(ALIAS_RE);
    if (orig) return { kind: 'add-alias', wrong: orig[1].trim(), right: orig[2].trim() };
  }


  // Go idle — dismiss / stand down. Instant, no agent. Bare "stop" means stand
  // down here; "stop music"/"stop spotify" still hit the media control below.
  if (/^(go )?idle$/.test(t) || /^stop$/.test(t) || /^cancel$/.test(t) || /^never ?mind$/.test(t) || /^that'?s all$/.test(t) || /^forget it$/.test(t))
    return { kind: 'idle' };

  // Presence loop mute/wake — must beat other matchers ("shut up", "be quiet",
  // "go to sleep", "wake up"). Bare "mute" stays audio-mute (handled far below).
  const presCmd = parsePresence(t);
  if (presCmd) return presCmd;

  // ── World Awareness — any topic (Stage 2/3) ──────────────────────────────
  // "what's happening with crypto / in the Middle East", "how's the market doing",
  // "energy update", "the weather". Must come BEFORE web-search so a world ask
  // opens the live view + reads real numbers. The renderer only GATES on a topic
  // hint; the main-side Stage-2 router does the precise resolve + graceful decline.
  // TOPIC_HINT keeps this from stealing other commands (mail, calendar, apps…).
  const TOPIC_HINT = /\b(crypto|bitcoin|ethereum|markets?|stocks?|equities|commodit\w*|gold|oil|news|headlines|world|europe|middle east|gulf|levant|asia|pacific|apac|africa|sahel|latin america|latam|south america|united states|the us|u\.s\.|america|energy|power grid|electricity|gas storage|government|regulat\w*|national debt|debt clock|treasury|conflict|wars?|military|security|tensions?|flashpoints?|geopolitic\w*|flights?|aviation|airports?|weather|forecast)\b/i;
  let wmHit;
  if ((wmHit = t.match(/^(?:(?:what'?s|what is)\s+(?:happening|going on|new|the\s+latest)\s+(?:with|in|on|around|for|across)\s+|how'?s\s+|how\s+is\s+|how\s+are\s+(?:things\s+(?:in|with|for|across)\s+)?|give\s+me\s+(?:a\s+|the\s+|my\s+)?|catch\s+me\s+up\s+on\s+|fill\s+me\s+in\s+on\s+|brief\s+me\s+on\s+|show\s+me\s+|open\s+)(.+?)(?:\s+(?:update|report|briefing|brief|snapshot|recap|read|check|view|doing|looking|going|today|right now|please))?$/i))
      && TOPIC_HINT.test(wmHit[1]))
    return { kind: 'world', topic: wmHit[1].trim() };
  // bare topic + report word: "crypto update", "markets report", "energy snapshot"
  if ((wmHit = t.match(/^(?:the\s+)?(.+?)\s+(?:update|report|briefing|brief|snapshot|recap|check|status)$/i)) && TOPIC_HINT.test(wmHit[1]))
    return { kind: 'world', topic: wmHit[1].trim() };
  // weather is common + unambiguous: "the weather", "what's the weather (in X)"
  if (/^(?:what'?s\s+)?(?:the\s+)?weather\b/i.test(t) || /^(?:what'?s\s+)?(?:the\s+)?forecast\b/i.test(t))
    return { kind: 'world', topic: t };
  // bare "world news" / "the news"
  if (/^(?:the\s+)?(?:world\s+)?news$/i.test(t) || /^what'?s\s+(?:in\s+)?the\s+news$/i.test(t))
    return { kind: 'world', topic: 'news' };

  // Morning briefing — special composition flow.
  if (/\b(morning\s+)?briefing\b/.test(t) || /\bbrief me\b/.test(t) || /\bwhat'?s my day\b/.test(t) || /\bwhat is my day\b/.test(t))
    return { kind: 'briefing' };

  // ── Continuous Awareness toggle (Stage 7) — opt-in screen watching ──────────
  // "start watching" / "watch my screen" / "keep an eye on me" → on.
  // "stop watching" / "stop keeping an eye on me" → off. (Bare "stop" stays idle.)
  if (/^stop watching\b/.test(t) || /\bstop keeping an eye\b/.test(t)
      || (/\b(stop|end|disable|turn off|quit)\b/.test(t) && /\bwatch(ing)?\b/.test(t)))
    return { kind: 'watch-off' };
  if (/^(start |begin )?watch(ing)?( my)?( screen| me)?$/.test(t) || /\bwatch my screen\b/.test(t)
      || /\bkeep an eye\b/.test(t)
      || (/\b(start|begin|enable|turn on)\b/.test(t) && /\bwatch(ing)?\b/.test(t)))
    return { kind: 'watch-on' };

  // ── Email read / summary (Zoho IMAP, no browser) ───────────────────────────
  // Singular ("read email") → speak the full body of the most recent unread.
  // Plural ("read emails" / "read my inbox" / "any new email") → summarize
  // unread count + top 3 senders. Both use window.hannibal.mailInbox() /
  // readMailBody() — never open Gmail or any browser. State queries like
  // "any new email" go plural even with a singular noun: the user is asking
  // about the inbox, not asking to be read one specific message.
  if (/^(?:read|tell me about|tell me|check|summari[sz]e|what'?s in|what is in)\s+(?:(?:my|the)\s+)?(?:unread\s+|new\s+|all\s+|recent\s+)?(?:emails|mails|messages|inbox)$/.test(t))
    return { kind: 'mail', mode: 'plural' };
  if (/^(?:any|is there|are there|do i have)\s+(?:new\s+|unread\s+|recent\s+)?(?:emails?|mails?|messages?|inbox)$/.test(t))
    return { kind: 'mail', mode: 'plural' };
  if (/^(?:read|tell me about|tell me|check|what is in)\s+(?:(?:my|the)\s+)?(?:latest\s+|last\s+|most recent\s+|recent\s+|new\s+|next\s+|unread\s+)?(?:email|mail|message)$/.test(t))
    return { kind: 'mail', mode: 'singular' };

  // ── Preference corrections (length, language, model, vague redo) ──────────
  // These attribute to lastTaskType in the dispatcher, so saying "shorter"
  // right after an email summary creates response_length.overrides.email_summary
  // = 'short'. Vague redo phrasings ("niet zo", "that's wrong") log without
  // a specific value so the user can review later. Order: specific patterns
  // first; the vague catch-all is last.
  if (/^(?:be )?(?:shorter|too long|more brief|briefer|cut it short|be brief|less)\.?$/i.test(t))
    return { kind: 'correction', type: 'length', value: 'short' };
  if (/^(?:longer|too short|more detail|more context|more info|elaborate|expand|in more detail|tell me more)\.?$/i.test(t))
    return { kind: 'correction', type: 'length', value: 'detailed' };
  let langMatch;
  if ((langMatch = t.match(/^(?:speak |reply |answer |respond )?in\s+(dutch|nederlands|english|engels|spanish|french|german|portuguese|italian)(?:\s+please)?$/i))) {
    const map = { nederlands: 'dutch', engels: 'english' };
    return { kind: 'correction', type: 'language', value: map[langMatch[1]] || langMatch[1] };
  }
  if (/^(?:use|switch to|try)\s+(?:the\s+)?(?:big|deep|heavy|large|powerful|smart|70b|llama)\s+(?:model|llm|brain)?\.?$/i.test(t)
      || /^think harder\.?$/i.test(t)
      || /^use the heavy model\.?$/i.test(t))
    return { kind: 'correction', type: 'model', value: 'deep' };
  if (/^(?:use|switch to|try)\s+(?:the\s+)?(?:fast|small|quick|light|fast)\s+(?:model|llm|brain)?\.?$/i.test(t)
      || /^be (?:quick|fast|quicker|faster)\.?$/i.test(t))
    return { kind: 'correction', type: 'model', value: 'fast' };
  // Vague: "no that's wrong" / "niet zo" / "that wasn't right" — only when
  // there's NO pending alias-suggestion confirmation (the gate at the top of
  // handleCommand already intercepts bare yes/no in that case).
  if (/^(?:no,? )?(?:that(?:'?s| ?is) (?:wrong|not (?:right|it|correct))|niet zo|that wasn'?t (?:right|it)|incorrect|wrong)\.?$/i.test(t))
    return { kind: 'correction', type: 'redo', value: null };

  // ── Praise from Fred — flips Hannibal's state to "grateful". Stoic ack,
  //    not effusive. "Good job", "nice work", "well done", "thanks"...
  //    Must come BEFORE the filler-strip catches "thanks" alone.
  if (/^(?:thanks?|thank you|good job|good work|nice (?:work|one|job)|well done|great (?:job|work)|that.s perfect|nailed it|appreciate (?:it|that)|excellent|cheers)(?:,?\s+hannibal)?\.?$/i.test(t))
    return { kind: 'praise' };

  // ── Skill management voice commands ──────────────────────────────────────
  // "teach me a new skill" / "teach me something new" → enter teach mode.
  // "what skills do you know" / "list my skills"      → speak the skill list.
  // "forget the X skill" / "delete the X skill"        → remove by name match.
  if (/^(?:teach (?:me )?(?:a |something )?(?:new )?(?:skill|something)|let'?s teach you something|i want to teach you (?:something|a skill))\.?$/i.test(t))
    return { kind: 'skill-teach' };
  if (/^(?:what skills (?:do you |can you )?know|list (?:my |your )?skills|show (?:me )?(?:your |my )?skills|what (?:can )?you do)\.?$/i.test(t))
    return { kind: 'skill-list' };
  let skillRm;
  if ((skillRm = t.match(/^(?:forget|delete|remove|drop)\s+(?:the\s+)?(.+?)\s+skill\.?$/i))) {
    return { kind: 'skill-forget', target: skillRm[1].trim() };
  }

  // ── "What have you learned about me?" — speak current preferences ─────────
  if (/^(?:what (?:have|did) you learn(?:ed)? about me|what do you know about me|show me what you (?:have )?learned|tell me what you (?:have )?learned)\.?$/i.test(t)
      || /^(?:show me|list|read me|tell me|what are)\s+(?:my\s+|the\s+)?(?:preferences|prefs|learned (?:stuff|things|preferences))\.?$/i.test(t)
      || /^(?:my\s+)?(?:preferences|prefs)\.?$/i.test(t))
    return { kind: 'preferences-read' };

  // ── Web read ─────────────────────────────────────────────────────────────
  // "Read this page <URL>" / "Summarize <URL>" / "What's on <URL>"
  // "Read my browser" / "What does this article say" → pull active Chrome URL
  let webMatch;
  const origForUrl = text.trim().replace(/[.?!]+$/, '');   // case-preserved for URLs
  if ((webMatch = origForUrl.match(/^(?:read|summari[sz]e)\s+(?:this\s+page\s+|the\s+page\s+|that\s+page\s+)?(https?:\/\/\S+)$/i))
      || (webMatch = origForUrl.match(/^what'?s\s+(?:on|at)\s+(https?:\/\/\S+)$/i))) {
    return { kind: 'web-read', url: webMatch[1] };
  }
  if (/^(?:read|summari[sz]e)\s+(?:what'?s\s+in\s+)?my\s+(?:browser|tab|current\s+(?:page|tab))$/i.test(t)
      || /^(?:what\s+does|read me)\s+(?:this|that|the)\s+(?:article|page|tab|story)(?:\s+say)?$/i.test(t)
      || /^summari[sz]e\s+(?:this|that|the)\s+(?:article|page|tab|story)$/i.test(t)) {
    return { kind: 'web-read', url: null };
  }

  // ── Site-down check ──────────────────────────────────────────────────────
  // "Is github.com down" / "Is twitter down" — must come BEFORE the generic
  // web-search patterns so "is X down" doesn't get swallowed as a search query.
  // Captured against origForUrl so host casing/punctuation survives.
  let downMatch;
  if ((downMatch = origForUrl.match(/^(?:is|are)\s+(.+?)\s+(?:down|offline|broken|up)\??$/i))) {
    return { kind: 'site-down', target: downMatch[1].trim() };
  }

  // ── Web search (SearXNG) — unambiguous shapes ──────────────────────────
  // "google X" and "look up X" are web-only triggers (no collision with the
  // file-search verbs find/search/look-for). The "what's the latest on/about
  // X" pattern allows a chained noun (latest news on, latest update about) so
  // "What is the latest news about Bitcoin" parses. The remaining "search
  // for X" shape lives BELOW the file-search block to defer to file-search
  // Shape 1 ("search for invoice files"). Query captured from origForUrl so
  // proper nouns keep their casing for the LLM summary.
  let searchMatch;
  if ((searchMatch = origForUrl.match(/^(?:what'?s|what is)\s+(?:the\s+)?(?:latest|new|recent)(?:\s+(?:news|update|info|story|happenings))?\s+(?:on|about|with|regarding|for)\s+(.+?)\??$/i))
      || (searchMatch = origForUrl.match(/^(?:what'?s|what is)\s+(?:the\s+)?news\s+(?:on|about|with|regarding)\s+(.+?)\??$/i))) {
    return { kind: 'web-search', query: searchMatch[1].trim() };
  }
  // "(Search for|Find me|What's) (the) latest X news" — topic sandwiched between
  // a leading "latest/breaking/recent" qualifier and a trailing "news/update/story"
  // noun. Catches a phrasing Whisper produces often that would otherwise fall
  // into file-search Shape 3 because it starts with "search for".
  if ((searchMatch = origForUrl.match(/^(?:search\s+for\s+|find\s+me\s+|what'?s\s+|what is\s+)?(?:the\s+)?(?:latest|breaking|recent|new)\s+(.+?)\s+(?:news|updates?|story|stories|happenings)\??$/i))) {
    return { kind: 'web-search', query: searchMatch[1].trim() };
  }
  if ((searchMatch = origForUrl.match(/^(?:google|look up)\s+(.+?)\??$/i))) {
    return { kind: 'web-search', query: searchMatch[1].trim() };
  }
  if ((searchMatch = origForUrl.match(/^find\s+(?:information|info|details)\s+(?:about|on|for|regarding)\s+(.+?)\??$/i))) {
    return { kind: 'web-search', query: searchMatch[1].trim() };
  }

  // ── Reminders ─────────────────────────────────────────────────────────────
  // "Remind me [in N min|at HH(:MM)|tomorrow at H] to <message>"
  // "What reminders do I have" / "Cancel the <name> reminder"
  let remMatch;
  if ((remMatch = t.match(/^(?:remind me|set a reminder)\s+(in\s+.+?|at\s+.+?|tomorrow.+?|today.+?)\s+(?:to\s+|that\s+|about\s+)(.+)$/i))
      || (remMatch = t.match(/^(?:remind me|set a reminder)\s+(?:to\s+|that\s+|about\s+)(.+?)\s+(in\s+.+|at\s+.+|tomorrow.+|today.+)$/i))) {
    // Pattern 1 captures [time, message]; pattern 2 captures [message, time].
    // Distinguish by whether group 1 starts with a time word.
    const isTimeFirst = /^(?:in|at|tomorrow|today)\b/i.test(remMatch[1]);
    const timePart = isTimeFirst ? remMatch[1] : remMatch[2];
    const msgPart  = isTimeFirst ? remMatch[2] : remMatch[1];
    return { kind: 'reminder-set', message: msgPart.trim(), parsed: parseTimePhrase(timePart) };
  }
  if (/^(?:what|which)\s+reminders?\s+(?:do\s+i\s+have|are\s+(?:there|set|active))\??$/i.test(t)
      || /^list\s+(?:my\s+)?reminders?\.?$/i.test(t)) {
    return { kind: 'reminder-list' };
  }
  let cancelRem;
  if ((cancelRem = t.match(/^(?:cancel|delete|remove)\s+(?:the\s+)?(.+?)\s+reminder\.?$/i))) {
    return { kind: 'reminder-cancel', target: cancelRem[1].trim() };
  }

  // ── Timers ────────────────────────────────────────────────────────────────
  // "Set a timer for N minutes [for <label>]" / "Timer N minutes"
  // "How much time is left" / "Cancel the timer" / "Cancel the pasta timer"
  let timerMatch;
  if ((timerMatch = t.match(/^(?:set\s+(?:a\s+)?timer\s+(?:for\s+)?|start\s+(?:a\s+)?timer\s+(?:for\s+)?|timer\s+(?:for\s+)?)(\d+\s*(?:sec|min|hour)\S*)(?:\s+for\s+(.+))?$/i))) {
    return { kind: 'timer-set', label: (timerMatch[2] || '').trim(), parsed: parseTimePhrase(timerMatch[1]) };
  }
  if (/^(?:how\s+much\s+time\s+(?:is\s+)?left|how\s+long\s+left|time\s+left|timer\s+status)\??$/i.test(t)
      || /^(?:what'?s|what is)\s+(?:on\s+)?(?:my\s+)?(?:timer|timers)\??$/i.test(t)
      || /^list\s+(?:my\s+)?timers?\.?$/i.test(t)) {
    return { kind: 'timer-list' };
  }
  let cancelTimer;
  if ((cancelTimer = t.match(/^(?:cancel|stop|kill)\s+(?:the\s+)?(?:(.+?)\s+)?timer\.?$/i))) {
    return { kind: 'timer-cancel', target: (cancelTimer[1] || '').trim() };
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  // Capture content from ORIGINAL (case-preserved) text — note bodies aren't
  // commands and should stay as written.
  let noteMatch;
  if ((noteMatch = origForUrl.match(/^(?:take a note|note to self|remember that|make a note|note that)[:,]?\s+(.+)$/i))) {
    return { kind: 'note-add', content: noteMatch[1].trim() };
  }
  if ((noteMatch = origForUrl.match(/^find (?:my\s+)?note(?:s)?\s+(?:about|on|with|matching|for)\s+(.+)$/i))) {
    return { kind: 'note-find', query: noteMatch[1].trim() };
  }
  if (/^(?:read|tell me|list|show me)\s+(?:my\s+)?notes?\s+(?:from\s+)?today\.?$/i.test(t)
      || /^today'?s\s+notes?\.?$/i.test(t)
      || /^(?:read|list|show me)\s+(?:my\s+)?notes?\.?$/i.test(t)) {
    return { kind: 'note-read-today' };
  }
  if (/^(?:delete|remove|forget)\s+(?:that|the last|my last)\s+note\.?$/i.test(t)) {
    return { kind: 'note-delete-last' };
  }

  // ── Translate ─────────────────────────────────────────────────────────────
  // "How do you say <phrase> in <language>"
  // "Translate <text> to <language>"
  // "What does <foreign phrase> mean"
  let trMatch;
  if ((trMatch = origForUrl.match(/^how\s+do\s+you\s+say\s+(.+?)\s+in\s+(dutch|english|spanish|french|german|portuguese|italian|nederlands|french|deutsch)\.?$/i))) {
    return { kind: 'translate', text: trMatch[1].trim(), language: trMatch[2] };
  }
  if ((trMatch = origForUrl.match(/^translate\s+(.+?)\s+(?:in)?to\s+(dutch|english|spanish|french|german|portuguese|italian|nederlands|deutsch)\.?$/i))) {
    return { kind: 'translate', text: trMatch[1].trim(), language: trMatch[2] };
  }
  if ((trMatch = origForUrl.match(/^what\s+does\s+(.+?)\s+mean(?:\s+in\s+english)?\.?$/i))) {
    return { kind: 'translate', text: trMatch[1].trim(), language: 'english' };
  }

  // ── Clipboard ─────────────────────────────────────────────────────────────
  if (/^copy (?:that|this|it)\.?$/i.test(t)
      || /^(?:put|copy)\s+(?:that|this)\s+(?:in|to|into)\s+(?:my\s+)?clipboard\.?$/i.test(t)) {
    return { kind: 'clipboard-copy' };
  }
  if (/^paste (?:that|this|it)\.?$/i.test(t)
      || /^paste\s+(?:that|it|clipboard)$/i.test(t)
      || /^paste\s+(?:that|it)\s+in\s+\w+/i.test(t)) {
    return { kind: 'clipboard-paste' };
  }

  // ── Behavior log queries (read the last N commands aloud) ──────────────────
  // Two modes:
  //   recent → last 10 entries regardless of date
  //   today  → all entries since midnight (via ts, not day-of-week match)
  // These must come before the file-recent block below; "what did I do today"
  // would otherwise look adjacent to "what files did I change today".
  if (/^(?:show me|list|read me|tell me|read out)\s+(?:my\s+|the\s+)?(?:last|recent|latest|previous)\s+commands?$/.test(t)
      || /^what (?:are|were) my (?:last|recent|latest)\s+commands?$/.test(t)
      || /^my\s+(?:last|recent|latest)\s+commands?$/.test(t))
    return { kind: 'behavior-recent', mode: 'recent' };
  if (/^what (?:did i|have i)\s+(?:do|done|ask|asked|say|said|tell you|told you)\s*(?:today|so far|this morning)?$/.test(t)
      || /^what commands? (?:did i|have i)\s+(?:give|gave|say|said|use|used)\s*(?:today|recently|so far)?$/.test(t)
      || /^(?:show me\s+)?today'?s\s+commands?$/.test(t)
      || /^(?:show me\s+)?todays\s+commands?$/.test(t)
      || /^(?:my\s+)?commands?\s+(?:today|so far)$/.test(t))
    return { kind: 'behavior-recent', mode: 'today' };

  // ── File system fast paths (Spotlight-backed; no LLM) ──────────────────────
  // Search:   "find <name> file" / "find files about <name>" / "search for <name>"
  // Recent:   "what files did I change today" / "recent files" / "files I touched"
  // Open:     "open that" / "open the first one"  (uses lastFileResults)
  // Read:     "read that file" / "read that document"  (uses lastFileResults[0])
  // Each speaks results + populates lastFileResults so the next turn can act.
  let fileMatch;
  // Shape 1 — "find/search for X <noun>". Noun list widened beyond just
  // file/document/pdf to cover the actual things people search for: contracts,
  // invoices, receipts, statements, presentations, decks, spreadsheets, folders,
  // notes, memos, agreements, scripts. The captured X is the query; the noun
  // determines `type` only when it's specifically pdf/doc(x).
  if ((fileMatch = t.match(/^(?:find|search for|search|look for)\s+(?:the\s+|a\s+|my\s+|some\s+|that\s+)?(.+?)\s+(?:files?|documents?|pdfs?|docs?|docx|contracts?|agreements?|invoices?|receipts?|statements?|presentations?|slides?|decks?|spreadsheets?|sheets?|folders?|directorys?|directories|notes?|memos?|scripts?|emails?)$/))) {
    const q = fileMatch[1].trim();
    const noun = (fileMatch[0].match(/(pdfs?|docs?|docx)\b/) || [])[1] || '';
    const type = /^pdfs?$/.test(noun) ? 'pdf' : /^(docs?|docx)$/.test(noun) ? 'doc' : 'all';
    return { kind: 'file-search', query: q, type, reply: `Searching for ${q}.` };
  }
  // Shape 2 — "find files/documents about|named|called|matching|for|with X"
  if ((fileMatch = t.match(/^(?:find|search for|search|look for)\s+(?:files?|documents?)\s+(?:about|named|called|matching|for|with)\s+(.+)$/))) {
    return { kind: 'file-search', query: fileMatch[1].trim(), type: 'all', reply: `Searching for ${fileMatch[1].trim()}.` };
  }
  // Shape 3 — loose fallback: bare "find X" with no recognized trailing noun.
  // Negative lookahead skips "find out X" (phrasal verb meaning "discover").
  // Captures whatever follows the optional possessive — feeds mdfind directly.
  // This is what catches "find the Revalis contract" when "contract" isn't
  // close enough to the noun list, and "find Revalis" when nothing trails.
  if ((fileMatch = t.match(/^(?:find|search for|look for)\s+(?!out\b)(?:the\s+|a\s+|my\s+|some\s+|that\s+)?(.{2,})$/))) {
    const q = fileMatch[1].trim();
    return { kind: 'file-search', query: q, type: 'all', reply: `Searching for ${q}.` };
  }
  if (/^(?:what files?|which files?)\s+(?:did i|have i)\s+(?:change|modify|edit|touch|work on|update)d?\s+(?:today|recently|this week|in the last (?:hour|day|week))?\??$/.test(t)
      || /^(?:recent|recently changed|recently modified|today'?s)\s+files\??$/.test(t)
      || /^files?\s+i\s+(?:changed|modified|edited|touched)\s+(?:today|recently)\??$/.test(t)) {
    const hours = /\bweek\b/.test(t) ? 168 : /\bhour\b/.test(t) ? 1 : 24;
    return { kind: 'file-recent', hours, type: 'all' };
  }
  // "open that" / "open the first one" / "open that PDF" / "open the document"
  if (/^(?:open|launch)\s+(?:that|it|the (?:file|one|first(?:\s+one)?|result|pdf|doc|document))(?:\s+(?:pdf|doc|document|file|one))?$/.test(t)) {
    return { kind: 'file-open', target: 0 };
  }
  // "look again" / "try again" / "search again" → replay the last search.
  // Must come BEFORE parseVision (later in this function), which would
  // otherwise be tempted to interpret bare "look" as a vision intent. We're
  // scoped to "<verb> again" so "look at me" / "look at the screen" still
  // route correctly to vision.
  if (/^(?:look|try|search|do (?:it|that))\s+again$/.test(t)) {
    return { kind: 'file-search-again' };
  }
  if (/^(?:read|tell me)\s+(?:that|the)\s+(?:file|document|pdf|doc)$/.test(t)) {
    return { kind: 'file-read', target: 0 };
  }
  // "read /absolute/path" or "read ~/relative/path" — match the verb case-
  // insensitively but pull the path from the ORIGINAL text so it isn't
  // lowercased (macOS paths are case-sensitive in general).
  const origPath = text.trim().replace(/[.?!]+$/, '');
  if ((fileMatch = origPath.match(/^(?:read|open and read)\s+((?:\/|~\/)\S+)$/i))) {
    return { kind: 'file-read', target: fileMatch[1] };
  }

  // ── Web search fallback — "search for X" / "search the web for X" ──────
  // Placed AFTER file-search so "search for invoice files" routes to the
  // mdfind shape first. Anything that didn't match a file pattern (no
  // trailing file noun) lands here. origForUrl preserves casing for the
  // LLM. Bare "search X" intentionally NOT included — too ambiguous.
  const origForSearch = text.trim().replace(/[.?!]+$/, '');
  let searchFallback;
  if ((searchFallback = origForSearch.match(/^search\s+(?:for|the web for|the internet for|online for|the web|the internet|online)\s+(.+?)\??$/i))) {
    return { kind: 'web-search', query: searchFallback[1].trim() };
  }

  // ── "Open …" routing (apps / URLs / dev editors) ───────────────────────────
  // Fast local action: no LLM round-trip. Three patterns, most-specific first:
  //   1) "open cursor in mellow yellow" → open-in-editor (project + dev tool)
  //   2) "open revalishousing.com"      → browser open (URL with TLD)
  //   3) "open <bookmark>"              → browser bookmark (web-only names)
  //   4) "open <anything else>"         → open-app (alias → exact → fuzzy)
  // App-vs-bookmark conflict resolution: anything with a first-class macOS app
  // (Slack, Notion, Calendar, Chrome, …) routes to the APP. Only clearly
  // web-only services live in WEB_ONLY. Native side wins on ambiguity because
  // that's what the user asked for in the most recent intent change.
  let openMatch;
  if ((openMatch = t.match(/^(?:open|launch|start)\s+(claude code|claude|cc|cursor|vs ?code|vscode|code)\s+(?:in|for|with|on)\s+(.+)$/))) {
    const ed = openMatch[1].replace(/\s+/g, '').toLowerCase();
    const proj = openMatch[2].trim();
    return { kind: 'mac', action: 'open-in-editor', params: JSON.stringify({ editor: ed, project: proj }), speakResult: true, speakError: true, reply: `Opening ${proj}.` };
  }
  if ((openMatch = t.match(/^(?:open|go to|navigate to|visit)\s+(https?:\/\/\S+|(?:[\w-]+\.)+[a-z]{2,8}(?:\/\S*)?)$/i))) {
    return { kind: 'browser', action: 'open', params: openMatch[1].trim(), reply: 'Opening that.' };
  }
  if ((openMatch = t.match(/^(?:open|launch|start)\s+(.+)$/))) {
    const target = openMatch[1].trim();
    const WEB_ONLY = new Set([
      // gmail removed — Fred uses Zoho Mail. "Open Gmail" should NOT navigate
      // to Google Mail; if he says "read email" it routes to readEmailViaIMAP.
      'chatgpt', 'supabase', 'vercel', 'drive', 'docs', 'sheets',
      'lovable', 'n8n', 'revalis', 'stripe', 'suite synq', 'mellow yellow',
      'linkedin', 'twitter', 'x', 'youtube', 'github',
    ]);
    if (WEB_ONLY.has(target.toLowerCase())) {
      return { kind: 'browser', action: 'bookmark', params: target.toLowerCase(), reply: `Opening ${target}.` };
    }
    return { kind: 'mac', action: 'open-app', params: target, speakError: true, reply: `Opening ${target}.` };
  }

  // Quit / switch apps — instant (were [APP: quit|…] / [APP: switch|…] tags). Model
  // switches ("switch to the fast model") are caught earlier; "go to sleep" / "close
  // tab" are excluded so they keep their own paths.
  let appCtl;
  if ((appCtl = t.match(/^(?:quit|close|exit)\s+(.+)$/)) && !/\b(tab|window|browser|page|this|that)\b/.test(appCtl[1])) {
    const name = appCtl[1].replace(/\s+app$/, '').trim();
    return { kind: 'mac', action: 'quit-app', params: name, speakError: true, reply: `Closing ${name}.` };
  }
  if ((appCtl = t.match(/^(?:switch to|bring up|jump to)\s+(.+)$/)) && !/\bsleep\b/.test(appCtl[1])) {
    const name = appCtl[1].replace(/\s+app$/, '').trim();
    return { kind: 'mac', action: 'switch-app', params: name, speakError: true, reply: `Switching to ${name}.` };
  }

  // ── Instant system-info lookups & toggles ──────────────────────────────────
  // One-shot queries/toggles that should answer in ~1s, NOT pay the agent's 30s+
  // round-trip. speakResult:true speaks the command's stdout. Checked BEFORE
  // parseVision so "lock the screen" / "sleep the screen" aren't grabbed as a
  // vision request. Patterns are scoped to query phrasing ("my battery") so
  // talking ABOUT a topic ("battery technology") still falls through to chat.
  let m;

  // Battery / power level
  if (/^battery$/.test(t) || /\b(my|the)\s+battery\b/.test(t) || /\bbattery\s+(level|percentage|percent|status|charge|life)\b/.test(t) || /\bhow much (battery|charge|power)\b/.test(t) || /\bwhat'?s (my|the) battery\b/.test(t))
    return { kind: 'mac', action: 'battery', speakResult: true, reply: 'Checking battery.' };

  // Disk / storage
  if (/\bdisk\s*space\b/.test(t) || /\bfree\s+space\b/.test(t) || /\bhow much (disk|storage|space)\b/.test(t) || /\bstorage (left|free|space|available)\b/.test(t))
    return { kind: 'mac', action: 'disk-space', speakResult: true, reply: 'Checking disk space.' };

  // Uptime
  if (/\buptime\b/.test(t) || /\bhow long (has|have).*\bbeen (up|on|running)\b/.test(t))
    return { kind: 'mac', action: 'uptime', speakResult: true, reply: 'Checking uptime.' };

  // Wi-Fi (status, or on/off toggle)
  if (/\bwi-?fi\b/.test(t)) {
    if (/\b(turn on|enable|connect)\b/.test(t)) return { kind: 'mac', action: 'wifi-toggle', params: 'on', reply: 'Wi-Fi on.' };
    if (/\b(turn off|disable|disconnect)\b/.test(t)) return { kind: 'mac', action: 'wifi-toggle', params: 'off', reply: 'Wi-Fi off.' };
    return { kind: 'mac', action: 'wifi-status', speakResult: true, reply: 'Checking Wi-Fi.' };
  }
  if (/\b(am i|are we)\s+(connected|online)\b/.test(t) || /\b(internet|network)\s+(status|connection|connected)\b/.test(t))
    return { kind: 'mac', action: 'wifi-status', speakResult: true, reply: 'Checking connection.' };

  // Bluetooth on/off (parallels Wi-Fi; backend blueutil). Only on an explicit
  // toggle verb, and not on a question ("is bluetooth on?") — those aren't commands.
  if (/\bbluetooth\b/.test(t) && !/^(is|are|what|how|does)\b/.test(t)
      && /\b(turn|switch|enable|disable|connect|disconnect|toggle|on|off)\b/.test(t)) {
    const off = /\b(off|disable|disconnect)\b/.test(t);
    return { kind: 'mac', action: 'bluetooth-toggle', params: off ? 'off' : 'on', reply: off ? 'Bluetooth off.' : 'Bluetooth on.' };
  }

  // Do Not Disturb / Focus (backend: macOS Focus shortcut).
  if (/\b(do not disturb|dnd|focus mode|silence notifications)\b/.test(t)) {
    const off = /\b(off|disable|turn off|stop|end|cancel|unsilence)\b/.test(t);
    return { kind: 'mac', action: off ? 'dnd-off' : 'dnd-on', reply: off ? 'Do not disturb off.' : 'Do not disturb on.' };
  }

  // IP address
  if (/\bip\s*address\b/.test(t) || /\bwhat'?s my ip\b/.test(t) || /\bmy ip\b/.test(t))
    return { kind: 'mac', action: 'ip-address', speakResult: true, reply: 'Checking IP address.' };

  // Running apps
  if (/\bwhat'?s running\b/.test(t) || /\bwhat is running\b/.test(t) || /\b(list|running|open|which)\s+apps?\b/.test(t))
    return { kind: 'mac', action: 'list-apps', speakResult: true, reply: 'Checking running apps.' };

  // Desktop / Downloads contents
  if (/\b(what'?s on|on)\s+(my\s+)?desktop\b/.test(t) || /\bdesktop files\b/.test(t))
    return { kind: 'mac', action: 'desktop-files', speakResult: true, reply: 'Checking your desktop.' };
  if (/\b(what'?s in|in)\s+(my\s+)?downloads\b/.test(t) || /\bdownloads folder\b/.test(t))
    return { kind: 'mac', action: 'downloads-files', speakResult: true, reply: 'Checking your downloads.' };

  // Find a file by name (the "file" keyword keeps "find out …" from matching).
  if ((m = t.match(/^find (?:the |a |my )?file (?:called |named )?(.+)$/)))
    return { kind: 'mac', action: 'find-file', params: m[1].trim(), speakResult: true, reply: 'Searching for that file.' };

  // Clipboard contents
  if (/\bclipboard\b/.test(t) || /\bwhat'?s (copied|in my clipboard)\b/.test(t) || /\bwhat did i copy\b/.test(t))
    return { kind: 'mac', action: 'clipboard-get', speakResult: true, reply: 'Reading clipboard.' };

  // Dark mode (explicit on/off, else toggle)
  if (/\bdark mode\b/.test(t)) {
    if (/\b(off|disable|light mode)\b/.test(t)) return { kind: 'mac', action: 'dark-mode', params: 'off', reply: 'Dark mode off.' };
    if (/\b(on|enable)\b/.test(t)) return { kind: 'mac', action: 'dark-mode', params: 'on', reply: 'Dark mode on.' };
    return { kind: 'mac', action: 'dark-mode-toggle', reply: 'Toggling dark mode.' };
  }

  // Lock / sleep
  if (/^lock$/.test(t) || /\block (the |my )?(screen|mac|computer|display)\b/.test(t))
    return { kind: 'mac', action: 'lock', reply: 'Locking.' };
  // Sleep the machine. Matches the bare/explicit forms as a WHOLE utterance
  // ("sleep", "sleep now", "go to sleep", "execute sleep function") so they fire
  // this local function instantly and never reach the action/brain path — plus
  // the object forms ("sleep the mac/screen") anywhere in the sentence.
  if (/^(go to sleep( now)?|sleep( now)?|execute( the)? sleep function)$/.test(t)
      || /\bgo to sleep\b/.test(t)
      || /\b(put|send) (the |my )?(mac|computer|machine|display|screen) to sleep\b/.test(t)
      || /\bsleep (the |my )?(mac|computer|machine|display|screen)\b/.test(t))
    return { kind: 'mac', action: 'sleep', reply: 'Going to sleep.' };

  // Brightness
  if (/\bbrightness\b/.test(t) || /\bbright(er)?\b/.test(t) || /\bdim(mer)?\b/.test(t)) {
    if (/\b(down|lower|decrease|reduce|dim(mer)?)\b/.test(t)) return { kind: 'mac', action: 'brightness-down', reply: 'Brightness down.' };
    if (/\b(up|raise|increase|brighter)\b/.test(t)) return { kind: 'mac', action: 'brightness-up', reply: 'Brightness up.' };
  }

  // Camera STEERING — "kijk naar links", "kijk rond", "volg mij", "zoom in",
  // "camera terug". MUST come before parseVision so a directed look MOVES the
  // gimbal (camera.look) instead of a passive snapshot. Bare "what do you see"
  // has no steer verb → falls through to parseVision below (no move needed).
  const camCmd = parseCamera(t);
  if (camCmd) return { ...camCmd, prompt: text.trim() };

  // Camera vision — "how do I look", "what am I wearing", etc. (before media so
  // "what's my day look like" is already caught above as briefing).
  const vis = parseVision(t);
  if (vis) return { ...vis, prompt: text.trim() };

  // Instant media controls — nobody wants LLM latency to pause a song.
  if (/^(play|resume)( music| spotify)?$/.test(t)) return { kind: 'mac', action: 'spotify-play', reply: 'Playing.' };
  if (/^(pause|stop)( music| spotify)?$/.test(t)) return { kind: 'mac', action: 'spotify-pause', reply: 'Paused.' };
  if (/^(next|skip)( track| song)?$/.test(t)) return { kind: 'mac', action: 'spotify-next', reply: 'Skipping.' };
  if (/^mute$/.test(t)) return { kind: 'mac', action: 'volume-mute', reply: 'Muted.' };
  if (/^unmute$/.test(t)) return { kind: 'mac', action: 'volume-unmute', reply: 'Unmuted.' };
  if (/^(previous|previous (track|song)|last (track|song))$/.test(t) || /\b(previous|go back a|back one) (track|song)\b/.test(t))
    return { kind: 'mac', action: 'spotify-prev', reply: 'Going back.' };
  if (/^(what'?s playing|what song is this|what'?s this song|now playing|current (track|song))\??$/.test(t))
    return { kind: 'mac', action: 'spotify-current', speakResult: true, reply: 'Checking.' };
  if (/^(volume up|turn it up|louder|raise (the )?volume|increase (the )?volume|turn (the )?volume up)$/.test(t))
    return { kind: 'mac', action: 'volume-up', reply: 'Volume up.' };
  if (/^(volume down|turn it down|quieter|lower (the )?volume|decrease (the )?volume|turn (the )?volume down)$/.test(t))
    return { kind: 'mac', action: 'volume-down', reply: 'Volume down.' };
  const volSet = t.match(/^(?:set |change |put )?(?:the )?volume (?:to |at )?(\d{1,3})\s*%?$/);
  if (volSet) { const v = Math.max(0, Math.min(100, parseInt(volSet[1], 10))); return { kind: 'mac', action: 'volume-set', params: String(v), reply: `Volume ${v}.` }; }

  // Screenshot — instant, no context needed ("what's on my screen" is an agent task).
  if (/\bscreenshot\b/.test(t) && !/what'?s on/.test(t))
    return { kind: 'mac', action: 'screenshot', reply: 'Screenshot saved.' };

  // ── User-taught skills (last fast-path attempt before LLM fall-through) ──
  // Built-in patterns ABOVE this point always win, so a skill can't shadow
  // "open chrome" or other core commands. If no built-in matched, see if any
  // user-taught skill trigger fits.
  const skillHit = matchSkill(t);
  if (skillHit) return { kind: 'skill', skill: skillHit.skill, score: skillHit.score };

  // Everything else → null → classifyIntent → agent or chat.
  return null;
}

// ── INTENT CLASSIFIER ───────────────────────────────────────────────────────
// Cheap, regex-only decision: does this need the agent (computer control) or is
// it pure conversation? Keeps "tell me a joke" off the slow agent path.
// ── PHASE D — the pure arbiter decision (no side effects, unit-tested) ──────
// Decides whether an autonomous line may be spoken RIGHT NOW, given live state.
//   state: { phase, restfulListen, confirmInFlight, narrating, speaking,
//            autonomousSpeaking, vadHeardThisTurn, now, lastAutonomousTs,
//            lastAutonomousPriority, lastUserSpeakTs, screenBelief:{working,ts} }
//   candidate: { source:'camera'|'screen', priority }
//   cfg: { gapMs, preemptMs, focusMs, conversationMs }
// Returns { speak:boolean, reason:string }. Silence-biased: any doubt → don't speak.
function arbiterDecide(state, candidate, cfg) {
  // 1) OVERLAP GUARDS — never over Fred, the confirm gate, world narration, or
  //    in-progress speech. Rest = plain idle, or the restful open-mic window.
  if (state.confirmInFlight) return { speak: false, reason: 'gate' };
  if (state.narrating) return { speak: false, reason: 'narrating' };
  if (state.speaking) return { speak: false, reason: 'speaking' };
  if (state.autonomousSpeaking) return { speak: false, reason: 'autonomous' };
  const resting = state.phase === 'idle' || state.restfulListen;
  if (!resting) return { speak: false, reason: `phase:${state.phase}` };
  // 2) FRED IS MID-UTTERANCE → never interject.
  if (state.vadHeardThisTurn) return { speak: false, reason: 'fred-speaking' };
  // 3) GLOBAL RATE-LIMIT across ALL autonomous sources. A higher-priority line
  //    (screen help) may PREEMPT a lower-priority one (camera chat) after a short
  //    floor, so a real "want help?" isn't blocked by earlier small-talk.
  const prio = candidate.priority || 1;
  const sinceLast = state.now - (state.lastAutonomousTs || 0);
  const gapOk = sinceLast >= cfg.gapMs
    || (prio > (state.lastAutonomousPriority || 0) && sinceLast >= cfg.preemptMs);
  if (!gapOk) return { speak: false, reason: `rate-limit(${Math.round(sinceLast / 1000)}s)` };
  // 4) CROSS-MODAL VETOES — only for camera chit-chat (screen help is on-topic):
  //    (a) Fred heads-down working on screen → hold; (b) Fred just spoke → he's in
  //    conversation, don't small-talk over the lull.
  if (candidate.source === 'camera') {
    const sb = state.screenBelief;
    if (sb && sb.working && (state.now - (sb.ts || 0) < cfg.focusMs)) return { speak: false, reason: 'heads-down' };
    if (state.lastUserSpeakTs && (state.now - state.lastUserSpeakTs < cfg.conversationMs)) return { speak: false, reason: 'in-conversation' };
  }
  return { speak: true, reason: 'ok' };
}

function classifyIntent(text) {
  const t = text.toLowerCase().trim();

  const CHAT_PATTERNS = [
    /^(hi|hello|hey|good morning|good evening|what's up|how are you)/,
    /^(tell me a |what do you think|do you know|who is|what is(?! on| in| running))/,
    /^(explain|describe|define|meaning of|history of)/,
    /^(thanks|thank you|cheers|ok|okay|cool|nice|great|perfect|awesome)/,
    /^(yes|no|yeah|nah|sure|nope)$/,
    /\b(joke|story|poem|song|lyrics|recipe)\b/,
    /\b(opinion|think about|thoughts on|advice|recommend|suggest)\b/,
  ];
  if (CHAT_PATTERNS.some((p) => p.test(t))) return 'chat';

  const ACTION_PATTERNS = [
    /\b(open|close|quit|launch|start|switch to|go to|navigate)\b/,
    /\b(click|tap|press|select|choose|check|toggle)\b/,
    /\b(type|enter|fill|write|send|reply|forward|compose)\b/,
    /\b(scroll|refresh|reload|back|forward|zoom)\b/,
    /\b(search|google|find|look up|look for)\b/,
    /\b(play|pause|stop|skip|next|previous|volume|mute)\b/,
    /\b(screenshot|screen|capture|record)\b/,
    /\b(lock|sleep|shut down|restart|dark mode|brightness|wifi|bluetooth)\b/,
    /\b(battery|disk|storage|uptime|running|clipboard|copy|paste)\b/,
    /\b(whatsapp|message|text|email|call)\b/,
    /\b(download|upload|save|move|delete|trash|rename)\b/,
    /\b(show me|pull up|bring up|take me to|help me)\b/,
    /\b(what's on my|what is on my|check my|read my)\b/,
    /\b(set|change|turn on|turn off|enable|disable|adjust)\b/,
  ];
  if (ACTION_PATTERNS.some((p) => p.test(t))) return 'action';

  // Default: a question is chat; an imperative is an action.
  return /^(what|who|why|how|when|where|is|are|was|were|do|does|did|can|will|should)\b/.test(t) ? 'chat' : 'action';
}

// Fix common Whisper misrecognitions before routing. Brand/term names that
// Whisper consistently mangles get corrected here so command matching and the
// agent see the right words. Applied to BOTH spoken and typed input (typed
// might come from quick-action pills or the type-in field, which still
// benefit from a single canonical spelling reaching parseCommand).
function fixTranscript(text) {
  let t = text;
  // Self-learning aliases from data/aliases.json — applied first so the
  // existing per-line fixes (Revalis, Supabase, …) can still re-canonicalize
  // whatever the alias map produces (e.g. aliases.json maps "rivalis" →
  // "revalis"; the line below promotes "revalis" → "Revalis" for display).
  t = applyAliases(t);
  t = t.replace(/\bglaad\b/gi, 'Claude');
  t = t.replace(/\bwhat'?s app\b/gi, 'WhatsApp');     // "what's app" is unambiguously the app
  t = t.replace(/\bsuperbase\b/gi, 'Supabase');
  t = t.replace(/\breval(?:e|i)s\b/gi, 'Revalis');    // Revales / Revalis → Revalis
  // "what's up" is ALSO a greeting, so only rewrite it to "WhatsApp" when the
  // sentence clearly means the app (an open/messaging verb is present).
  if (/\b(open|launch|message|msg|text|send|reply)\b/i.test(t)) {
    t = t.replace(/\bwhat'?s up\b/gi, 'WhatsApp');
  }
  return t;
}

// Does this request require SEEING the screen? Only then do we pay for a
// screenshot + the slower, format-sloppier vision model. Triggers on explicit
// screen references ("what's on my screen", "read this page") and deictic
// action phrasing ("click that", "close this notification"). Everything else
// (open an app, go to a site, control volume) stays on the heavy text model.
function needsScreen(text) {
  const t = text.toLowerCase();
  return /\bon (the |my )?screen\b/.test(t)
    || /\bwhat('s| is| am i| do you)\b.*\b(see|seeing|screen|showing|display(ed)?)\b/.test(t)
    || /\bwhat do you see\b/.test(t)
    || /\bcurrent (page|screen|window|tab)\b/.test(t)
    || /\b(read|click|tap|press|select|check|close|dismiss|open)\b.*\b(this|that|these|those|it|here)\b/.test(t)
    || /\b(this|that)\b.*\b(page|screen|window|tab|notification|button|link|dialog|popup|message|email)\b/.test(t)
    || /\b(read|see|look at)\b.*\b(this|that|the current)\b/.test(t);
}

// Parse [TYPE: action|params] tags out of the LLM's response — tolerant of the
// ways smaller models mangle the format. We grab the whole inner string after the
// type and normalize it ourselves, so these all parse correctly:
//   [BROWSER: open|site.com]        → open / site.com         (clean)
//   [BROWSER: open url|site.com]    → open / site.com         (extra word before | dropped)
//   [APP: open Google Chrome]       → open / Google Chrome    (no pipe → first token is action)
//   [BROWSER: refresh|] / [BROWSER: scroll-down]  → action / '' (no/empty param)
// The action is always a single token; everything meaningful is the param.
function parseActionTags(text) {
  const actions = [];
  // Tag-type list is permissive: small models occasionally drop a character
  // ("WHATSAP" — one P) or misspell (APPS vs APP). We normalize aliases to the
  // canonical type below so the dispatcher still finds the handler.
  const tagRegex = /\[(APP|APPS|BROWSER|SYSTEM|SPOTIFY|WHATSAPP|WHATSAP|EMAIL|EMAILS|CONTINUE)\b([^\]]*)\]/gi;
  const TYPE_ALIAS = { APPS: 'APP', WHATSAP: 'WHATSAPP', EMAILS: 'EMAIL' };
  let m;
  while ((m = tagRegex.exec(text)) !== null) {
    const rawType = m[1].toUpperCase();
    const type = TYPE_ALIAS[rawType] || rawType;
    if (type === 'CONTINUE') { actions.push({ type, action: '', params: '' }); continue; }
    const inner = (m[2] || '').replace(/^\s*:\s*/, '').trim();   // strip leading ": "
    let action = '', params = '';
    const pipe = inner.indexOf('|');
    if (pipe >= 0) {
      // First token before the pipe is the action; any extra words before it
      // (e.g. "open url|…") are model noise. Everything after the pipe is the param.
      action = inner.slice(0, pipe).trim().split(/\s+/)[0] || '';
      params = inner.slice(pipe + 1).trim();
      // Collapse residual noise segments from double-pipe tags ("open|url|gmail.com"
      // → "gmail.com") by keeping the last segment. JSON params (which can legitimately
      // contain '|') start with { or [ and are left untouched.
      if (params.includes('|') && !/^[{[]/.test(params)) {
        const segs = params.split('|').map((s) => s.trim()).filter(Boolean);
        params = segs.length ? segs[segs.length - 1] : '';
      }
    } else {
      // No pipe: first token is the action, the remainder is the param.
      const sp = inner.search(/\s/);
      action = (sp === -1 ? inner : inner.slice(0, sp)).trim();
      params = sp === -1 ? '' : inner.slice(sp + 1).trim();
    }
    if (action) actions.push({ type, action: action.toLowerCase(), params });
  }
  // Second pass: catch unbracketed tag-shaped spans (small models sometimes
  // drop the brackets — "WHATSAPP: send|{...}" or "WHATSAP: send|..."). We
  // only consider spans NOT already inside a bracketed match (the strip above
  // removed them from the working string).
  const remaining = text.replace(/\[[^\]]*\]/g, ' ');
  const bareRegex = /\b(APPS?|BROWSER|SYSTEM|SPOTIFY|WHATSAPP|WHATSAP|EMAIL|EMAILS)\s*:\s*([A-Za-z-]+)\s*\|\s*([^\n\r]*)/gi;
  let bm;
  while ((bm = bareRegex.exec(remaining)) !== null) {
    const rawType = bm[1].toUpperCase();
    const type = TYPE_ALIAS[rawType] || rawType;
    const action = bm[2].toLowerCase();
    let params = bm[3].trim();
    // Trim trailing prose. If params start with { or [ we trust them as JSON
    // and let JSON.parse downstream handle balancing. Otherwise cut at the
    // first sentence-ending punctuation that isn't inside the params.
    if (!/^[{[]/.test(params)) {
      const cut = params.search(/[.!?](\s|$)/);
      if (cut > 0) params = params.slice(0, cut).trim();
    }
    if (action) actions.push({ type, action, params });
  }
  return actions;
}

// Execute one parsed action by dispatching to the existing IPC tool handlers.
async function executeAction({ type, action, params }) {
  switch (type) {
    case 'APP': {
      const appAction = action === 'open' ? 'open-app' : action === 'quit' ? 'quit-app' : 'switch-app';
      return window.hannibal.macControl(appAction, params);
    }
    case 'BROWSER':
      return window.hannibal.browserAction(action, params);
    case 'SYSTEM':
      return window.hannibal.macControl(action, params);
    case 'SPOTIFY':
      return window.hannibal.macControl('spotify-' + action, params);
    case 'WHATSAPP': {
      // Contact-name normalization happens up front in fixTranscript via the
      // shared aliases.json map, so the LLM already emits the canonical name.
      // We just wrap a bare search-name as JSON (the backend JSON-parses
      // both send and search params).
      const payload = action === 'send' ? params : JSON.stringify({ contact: params });
      return window.hannibal.macControl('whatsapp-' + action, payload);
    }
    case 'EMAIL':
      // 'check' goes to Zoho IMAP (the user does NOT use macOS Mail / Gmail).
      // We don't need to surface the data to the LLM here — the LLM already
      // narrated its own prose before the tag fires; this just keeps the
      // bookkeeping clean and avoids the legacy macOS Mail AppleScript path.
      if (action === 'check') return window.hannibal.mailInbox();
      return window.hannibal.macControl('email-send', params);
    default:
      console.warn('[agent] unknown action type:', type);
  }
}

// Classify a vision request and pick the source. Specific-display phrasing
// ("my laptop screen", "left monitor") wins first; then the generic /\bscreen\b/
// catches "what's on my screen"; otherwise camera-y phrasing → 'camera'.
// Returns { kind:'vision', mode } or null. Mode shapes:
//   'screen'         → ALL displays (multi-image to the vision model)
//   'screen-laptop'  → built-in display only
//   'screen-left'    → leftmost display by bounds.x
//   'screen-right'   → rightmost display by bounds.x
//   'camera'         → webcam
// Deliberately conservative on bare "look" so "look up the weather" stays a normal turn.
// PRESENCE control (NL + EN) — mute/wake the autonomous "alive" layer. Placed
// EARLY in parseCommand so "shut up"/"be quiet" win before other matchers. Bare
// "mute" is intentionally NOT hijacked here — it stays the existing audio-mute;
// presence-mute uses the unambiguous "shut up / be quiet / stil / hou je mond".
// Returns { kind:'presence', action, speak } or null.
function parsePresence(t) {
  // MUTE — stop talking, keep watching.
  if (/\b(shut up(?: now)?|be quiet|quiet down|zip it|hou je mond|hou je stil|wees stil|stil (?:nu|alsjeblieft)|zwijg|mute yourself|stop talking)\b/.test(t)
      || /^stil$/.test(t))
    return { kind: 'presence', action: 'mute', speak: 'Quiet.' };
  // UNMUTE — start talking again.
  if (/\b(you can (?:talk|speak)(?: again)?|you may (?:talk|speak)|talk to me again|start talking|unmute|praat maar|je mag (?:weer )?praten|praat weer)\b/.test(t))
    return { kind: 'presence', action: 'unmute', speak: "Okay, I'm back." };
  // SLEEP — fully reactive: stop proactive looking + talking.
  if (/\b(go to sleep|ga slapen|stop being proactive|stand down completely|go dormant|slaap lekker)\b/.test(t))
    return { kind: 'presence', action: 'sleep', speak: 'Going quiet — wake me when you need me.' };
  // WAKE — proactive again (starts the loop if it was stopped).
  if (/\b(wake up|word wakker|kom tot leven|come alive|come to life|be proactive|wakker worden)\b/.test(t))
    return { kind: 'presence', action: 'wake', speak: "I'm here." };
  return null;
}

// Camera STEERING intents (NL + EN) — these MOVE the OBSBOT, unlike parseVision's
// passive snapshot. Must run BEFORE parseVision in parseCommand so "kijk naar
// links"/"look left" become a real gimbal move, not a still capture. Directed
// looks return action:'look' → camera.look (tracker-off → nudge → capture → back
// to Fred). Returns { kind:'camera', action, params, speak?, target? } or null.
function parseCamera(t) {
  // follow / stay on me → AI tracking auto+upper (the rest state)
  if (/\b(follow me|stay on me|track me|keep me in (?:frame|shot|view)|lock on(?:to)? me)\b/.test(t))
    return { kind: 'camera', action: 'track', params: { mode: 'auto', frame: 'upper' }, speak: 'Staying on you.' };
  // stop following / look on your own → tracking off
  if (/\b(stop following|stop tracking|let me go|look on your own)\b/.test(t))
    return { kind: 'camera', action: 'track', params: { mode: 'off' }, speak: 'Letting you go.' };
  // recenter the gimbal
  if (/\b(recenter|re-?center the camera|center the camera|reset the camera|camera home)\b/.test(t))
    return { kind: 'camera', action: 'reset', params: {}, speak: 'Camera back to center.' };
  // zoom
  if (/\b(zoom in|zoom in on|closer)\b/.test(t))
    return { kind: 'camera', action: 'zoom', params: { direction: 'in' }, speak: 'Zooming in.' };
  if (/\b(zoom out|zoom (?:away|back)|further away)\b/.test(t))
    return { kind: 'camera', action: 'zoom', params: { direction: 'out' }, speak: 'Zooming out.' };
  // directional look — a steer verb (turn/point/move/look/pan/tilt) plus a
  // direction word. Sign is resolved main-side from the direction name.
  // Guard: "look up/for <something>" is a SEARCH, not a tilt — let it fall through.
  const isSearchPhrase = /\blook\s+(?:up|for)\s+\S/.test(t);
  if (!isSearchPhrase && /\b(pan|tilt|turn|point|move|look)\b/.test(t)) {
    const w = t.match(/\b(left|right|up|down)\b/);
    if (w) {
      const dir = w[1];
      return { kind: 'camera', action: 'look', params: { dir }, target: dir };
    }
  }
  // look around → a small sweep + capture
  if (/\b(look around|have a look around|scan the room)\b/.test(t))
    return { kind: 'camera', action: 'look', params: { around: true }, target: 'the room' };
  return null;
}

function parseVision(t) {
  // Specific-display routing — must come before the generic /\bscreen\b/ test.
  // "main" + "primary" included because they're natural for "main display".
  if (/\b(laptop|built[- ]?in|internal|main|primary)\s+(?:screen|display|monitor)\b/.test(t))
    return { kind: 'vision', mode: 'screen-laptop' };
  if (/\bleft\s+(?:screen|display|monitor)\b/.test(t))
    return { kind: 'vision', mode: 'screen-left' };
  if (/\bright\s+(?:screen|display|monitor)\b/.test(t))
    return { kind: 'vision', mode: 'screen-right' };
  if (/\b(?:screen|monitor|display|screens|monitors|displays)\b/.test(t))
    return { kind: 'vision', mode: 'screen' };
  const camera =
    /\b(camera|webcam)\b/.test(t) ||
    /\bwearing\b/.test(t) ||
    /look(s|ing)? like\b/.test(t) ||
    /\bhow do i look\b/.test(t) ||
    /\b(do|can) you see\b/.test(t) ||
    /\bwhat do you see\b/.test(t) ||
    /\blook at (me|this|that)\b/.test(t) ||
    /\bsee me\b/.test(t) ||
    // things Fred shows the camera: "what's in my hand", "what am I holding", "what is this?"
    /\b(in|on) my (hand|hands|lap|shirt|t-?shirt|desk)\b/.test(t) ||
    /\b(am i|i'?m) holding\b/.test(t) ||
    /\bholding (up|this|that)\b/.test(t) ||
    /^(what|who)(?:'s| is) (this|that)\??$/.test(t) ||
    /\b(show|showing) you\b/.test(t) ||
    // Dutch
    /\b(hoe zie ik eruit|wat zie je|kijk naar|in mijn hand|wat houd ik vast|wat is dit)\b/.test(t);
  return camera ? { kind: 'vision', mode: 'camera' } : null;
}

function appName(name) {
  const map = {
    'chrome': 'Google Chrome', 'google chrome': 'Google Chrome',
    'vs code': 'Visual Studio Code', 'vscode': 'Visual Studio Code', 'code': 'Visual Studio Code',
    'safari': 'Safari', 'finder': 'Finder', 'terminal': 'Terminal', 'figma': 'Figma',
    'spotify': 'Spotify', 'slack': 'Slack', 'notes': 'Notes', 'mail': 'Mail',
    'messages': 'Messages', 'whatsapp': 'WhatsApp', 'calendar': 'Calendar', 'music': 'Music',
    'notion': 'Notion', 'discord': 'Discord', 'zoom': 'zoom.us',
  };
  if (map[name]) return map[name];
  return name.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
