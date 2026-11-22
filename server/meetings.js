// ─────────────────────────────────────────────────────────────────────────
// MEETING MEMORY — Fred taps "Record meeting" on the iPhone; when he stops,
// the recording comes here. Hannibal:
//   1. transcribes it with who-said-what (ElevenLabs Scribe, speakers);
//   2. writes it up: title, short summary, decisions, action items;
//   3. offers to set reminders for Fred's own actions and to draft the
//      follow-up mail: each of those still needs Fred's yes;
//   4. keeps it (data/meetings/), so later "what did we agree with Jay on
//      Monday?" finds it (tools meetings.recent / meetings.find).
// The other side should know they're being recorded (Fred's responsibility;
// the app reminds him when he starts).
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TRANSCRIPT_CHARS = 180000;      // ~3 hours of talk; longer is cut for the write-up only

/** Long recordings with speakers: ElevenLabs Scribe, diarized. */
function makeMeetingTranscriber({ apiKey, model = 'scribe_v1', fetchImpl = fetch, diarize = true, timeoutMs = 20 * 60e3 }) {
  return async (audio, mime = 'audio/mp4') => {
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
    const type = String(mime || 'audio/mp4').split(';')[0].trim();
    const ext = (/mp4|m4a|aac/.test(type) && 'm4a') || (/webm/.test(type) && 'webm') || (/wav/.test(type) && 'wav') || (/mpeg|mp3/.test(type) && 'mp3') || 'ogg';
    const form = new FormData();
    form.append('model_id', model);
    form.append('diarize', diarize ? 'true' : 'false');
    form.append('tag_audio_events', 'false');
    form.append('file', new Blob([audio], { type }), `meeting.${ext}`);
    const r = await fetchImpl('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST', headers: { 'xi-api-key': apiKey }, body: form, signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j && j.detail && (j.detail.message || j.detail)) || `speech-to-text HTTP ${r.status}`);
    return { text: String(j.text || '').trim(), transcript: speakerLines(j.words) || String(j.text || '').trim(), language: j.language_code };
  };
}

/** Scribe words → "Speaker 1: …" lines, one per turn. */
function speakerLines(words) {
  if (!Array.isArray(words) || !words.length) return '';
  const names = new Map();
  const lines = [];
  let who = null, buf = '';
  for (const w of words) {
    if (w.type === 'audio_event') continue;
    const s = w.speaker_id || 'speaker_0';
    if (s !== who && w.type === 'word') {
      if (buf.trim()) lines.push(`${names.get(who)}: ${buf.trim()}`);
      if (!names.has(s)) names.set(s, `Speaker ${names.size + 1}`);
      who = s; buf = '';
    }
    buf += w.text;
  }
  if (buf.trim()) lines.push(`${names.get(who)}: ${buf.trim()}`);
  return lines.join('\n');
}

function followUpPrompt(summary) {
  return [
    'Fred just recorded a meeting and has already received this write-up:',
    summary,
    '',
    'Now, briefly: for HIS OWN action items that have a date, set reminders with the reminders tool (each one asks him yes/no first). If a follow-up mail to the others makes sense, show a short draft in the language of the meeting and ask if he wants it sent; never send without his yes. If there is nothing to do, answer with just "-".',
  ].join('\n');
}

function writeUpPrompt({ transcript, minutes, title, when }) {
  const cut = transcript.length > MAX_TRANSCRIPT_CHARS ? `${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}\n[… the rest was cut]` : transcript;
  return [
    `Fred recorded a meeting${title ? ` ("${title}")` : ''} on his iPhone: ${when}, about ${minutes} minutes. The transcript is below (speakers are numbered; work out who is who from the talk, Fred is usually the one who recorded).`,
    'Write it up for him, short and in plain text:',
    '1. A title line (who + what).',
    '2. Summary: 3 to 6 lines.',
    '3. Decisions (if any).',
    '4. Action items: who does what, by when.',
    'Answer in English unless the meeting was in another language Fred would prefer.',
    '',
    'TRANSCRIPT:',
    cut,
  ].join('\n');
}

// dir: data/meetings. transcribe(buf, mime) → { transcript, text, language }.
// writeUp(prompt) → text (one plain Claude call: the long transcript never
// enters the conversation history). followUp(prompt) → text (the brain with
// tools: offers reminders / a mail draft, each on Fred's yes). notify(text).
// remember(text) → memory store (optional).
function createMeetings({ dir, transcribe, writeUp, followUp, notify, remember, now = () => Date.now(), log = (...a) => console.log('[meetings]', ...a) } = {}) {
  if (dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} }
  const file = (id) => path.join(dir, `${id}.json`);
  const load = (id) => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch (_) { return null; } };
  const save = (m) => { try { fs.writeFileSync(file(m.id), JSON.stringify(m, null, 2)); } catch (e) { log('save failed:', e.message); } };

  function all() {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (_) {}
    return names.map((n) => load(n.slice(0, -5))).filter(Boolean).sort((a, b) => b.startedAt - a.startedAt);
  }

  const audioFile = (id) => path.join(dir, `${id}.audio`);

  /** A recording arrived. Returns at once; the write-up comes as a message. */
  function accept(audio, { mime, title, startedAt, seconds } = {}) {
    const id = crypto.randomBytes(6).toString('hex');
    const m = { id, title: String(title || '').slice(0, 120), startedAt: Number(startedAt) || now(), minutes: Math.max(1, Math.round((Number(seconds) || 0) / 60)), mime: String(mime || 'audio/mp4'), status: 'transcribing' };
    // The audio is kept until the write-up is done, so a failure can be tried again.
    try { fs.writeFileSync(audioFile(id), audio); } catch (e) { log('could not keep the audio:', e.message); }
    save(m);
    return { id, done: runJob(m, audio) };
  }

  function runJob(m, audio) {
    const mime = m.mime;
    return (async () => {
      try {
        const t = await transcribe(audio, mime);
        if (!t || !String(t.transcript || '').trim()) {
          m.status = 'empty'; save(m);
          await notify('🎙 I got the meeting recording, but I couldn\'t hear any talk in it.');
          return m;
        }
        m.transcript = t.transcript; m.language = t.language; m.status = 'writing'; save(m);
        const when = new Date(m.startedAt).toISOString().slice(0, 16).replace('T', ' ');
        const text = await writeUp(writeUpPrompt({ transcript: m.transcript, minutes: m.minutes, title: m.title, when }));
        m.summary = String(text || '').trim();
        if (!m.title) m.title = (m.summary.split('\n').find((l) => l.trim()) || 'Meeting').replace(/^[#*\d.\s]+/, '').slice(0, 120);
        m.status = 'done'; delete m.error; save(m);
        try { fs.unlinkSync(audioFile(m.id)); } catch (_) {}
        if (remember) remember(`Meeting "${m.title}" (${when}, ${m.minutes} min):\n${m.summary}`).catch(() => {});
        await notify(`🎙 Meeting written up\n\n${m.summary}`);
        if (followUp) {
          try {
            const next = String(await followUp(followUpPrompt(m.summary)) || '').trim();
            if (next && next !== '-') await notify(next);
          } catch (e) { log('follow-up failed:', e.message); }
        }
      } catch (e) {
        m.status = 'failed'; m.error = e.message; save(m);
        log('failed:', e.message);
        await notify(`🎙 I couldn't write up the meeting: ${e.message}. I kept the recording; say "try the meeting again" and I will.`).catch(() => {});
      }
      return m;
    })();
  }

  /** Try a failed one again (its audio was kept). */
  function retry(query) {
    const failed = all().filter((m) => m.status === 'failed' && (!query || m.id === query || String(m.title).toLowerCase().includes(String(query).toLowerCase())));
    const m = failed[0];
    if (!m) return { ok: false, error: 'There is no failed meeting recording to try again.' };
    let audio;
    try { audio = fs.readFileSync(audioFile(m.id)); } catch (_) { return { ok: false, error: 'That recording\'s audio is gone.' }; }
    m.status = 'transcribing'; save(m);
    runJob(m, audio);
    return { ok: true, note: 'Trying it again; the write-up comes as a message in a few minutes.' };
  }

  function recent(limit = 8) {
    return { ok: true, meetings: all().slice(0, Math.min(Number(limit) || 8, 30)).map(({ id, title, startedAt, minutes, status }) => ({ id, title, when: new Date(startedAt).toISOString().slice(0, 16).replace('T', ' '), minutes, status })) };
  }

  /** Words or names → the meetings that mention them, with their write-up and matching lines. */
  function find(query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (!words.length) return recent();
    const hits = [];
    for (const m of all()) {
      const hay = `${m.title}\n${m.summary || ''}\n${m.transcript || ''}`.toLowerCase();
      const score = words.filter((w) => hay.includes(w)).length;
      if (!score) continue;
      const lines = String(m.transcript || '').split('\n').filter((l) => words.some((w) => l.toLowerCase().includes(w))).slice(0, 8);
      hits.push({ score, m, lines });
    }
    hits.sort((a, b) => b.score - a.score || b.m.startedAt - a.m.startedAt);
    return { ok: true, meetings: hits.slice(0, 3).map(({ m, lines }) => ({ id: m.id, title: m.title, when: new Date(m.startedAt).toISOString().slice(0, 16).replace('T', ' '), minutes: m.minutes, summary: m.summary, lines })) };
  }

  return { accept, recent, find, retry, _all: all };
}

module.exports = { createMeetings, makeMeetingTranscriber, speakerLines, writeUpPrompt, followUpPrompt };
