// ─────────────────────────────────────────────────────────────────────────
// INTERPRETER — the phone on the table, two people, two languages.
// Each thing someone says (live talk's sentence detection on the iPhone)
// comes here: transcribe + detect the language, translate it into the OTHER
// language, and answer with the text and Hannibal's voice saying it.
// Fred's side: English by default (or Dutch when the other side is English).
// Languages: English, Dutch, French, Spanish (+ German, Italian, Portuguese).
// Nothing is stored: interpreting is not a conversation with Hannibal.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const NAMES = { en: 'English', nl: 'Dutch', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese' };
const ISO3 = { eng: 'en', nld: 'nl', dut: 'nl', fra: 'fr', fre: 'fr', spa: 'es', deu: 'de', ger: 'de', ita: 'it', por: 'pt' };

const norm = (c) => { const k = String(c || '').toLowerCase().slice(0, 3); return NAMES[k.slice(0, 2)] && k.length === 2 ? k : (ISO3[k] || (NAMES[k.slice(0, 2)] ? k.slice(0, 2) : '')); };

/** Which way to translate: what was heard → the other side's language. */
function direction(heardLang, mine, theirs) {
  const h = norm(heardLang);
  if (h && h === theirs) return { from: theirs, to: mine };
  if (h && h === mine) return { from: mine, to: theirs };
  // A third language, or unknown: it's probably the other side if it isn't Fred's.
  return h ? { from: h, to: h === mine ? theirs : mine } : { from: mine, to: theirs };
}

const SYSTEM = 'You are a live interpreter between two people talking face to face. Translate exactly what was said into the target language: natural spoken style, same tone and politeness, nothing added, no notes, no quotes. Names, numbers and places stay as they are. If the input is only a filler ("uh", "ok"), translate it as a filler.';

// transcribe(buf, mime) → { text, language }; translate(system, user) → text; speak(text) → mp3 Buffer
function createInterpreter({ transcribe, translate, speak }) {
  async function interpret(audio, mime, { mine = 'en', theirs = 'es' } = {}) {
    mine = norm(mine) || 'en'; theirs = norm(theirs) || 'es';
    if (mine === theirs) mine = theirs === 'en' ? 'nl' : 'en';
    const t = await transcribe(audio, mime);
    const heard = String((t && t.text) || '').trim();
    if (!heard || heard.replace(/[^\p{L}]/gu, '').length < 2) return { ok: true, heard: '' };
    const d = direction(t.language, mine, theirs);
    const text = String(await translate(SYSTEM, `Target language: ${NAMES[d.to]}.\n\n${heard}`) || '').trim();
    if (!text) return { ok: false, heard, error: 'No translation came back.' };
    let mp3 = null;
    try { mp3 = await speak(text); } catch (_) {}
    return { ok: true, heard, from: d.from, to: d.to, text, audio: mp3 ? Buffer.from(mp3).toString('base64') : undefined };
  }
  return { interpret };
}

module.exports = { createInterpreter, direction, norm, NAMES };
