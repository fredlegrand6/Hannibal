// ─────────────────────────────────────────────────────────────────────────
// ADDRESSEE — is this line meant for Hannibal, and how should he answer?
//
// Fred talks to Robert, to guests on camera, on the phone, in Dutch, Spanish
// or French; the TV runs. Hannibal used to guess, answered side-talk, read
// Fred's mood into it, or replied in the wrong language (answered Spanish to a
// guest's "Muy bien, gracias"). Fred's rules (22 Nov 2026):
//   • clearly side-talk → stay silent, only log it;
//   • not sure → one short neutral line, or nothing; never a mood reading;
//   • someone other than Fred is answered only when clearly talking to Hannibal;
//   • reply in English to Fred, unless Fred clearly asks for another language
//     or a guest talks to Hannibal directly (then that guest's language);
//   • the brain sees who spoke and how sure we are, e.g.
//     "speaker: fred (0.92), addressed: likely (0.74)".
//
// The hints and what they are worth (score 0..1):
//   his name ("Hannibal, …")            0.95  (said ABOUT him, "this is Hannibal": 0.5)
//   the "hey Jarvis" wake word           0.90
//   an open yes/no or teach question     0.90  (not from a clearly other voice)
//   a reply to his own question          0.80  (within the follow-up window)
//   a conversation is going              0.70  (he spoke in the last ~20 s)
//   nothing                              0.10
// then, unless he was named:
//   other voice −0.5 · voice not sure (when enrolled) −0.1 · Fred's voice +0.05
//   a language switch (not his reply language) −0.25 · others in the camera −0.2
//   starts by naming someone else ("Robert, …") −0.5 · a question/request +0.05
// Bands: ≥0.8 yes · ≥0.6 likely · ≥0.35 unsure · else no.
// Actions: yes/likely → answer (another voice: only on "yes"); unsure → one
// short neutral line if it is a question/request, else silent; no → silent.
// Plain functions, no DOM: node src/test-addressee.js
// ─────────────────────────────────────────────────────────────────────────
(function (root) {
  'use strict';

  const LANGS = ['english', 'dutch', 'french', 'spanish'];
  const CODE = { english: 'en', dutch: 'nl', french: 'fr', spanish: 'es' };
  const FROM_CODE = { en: 'english', nl: 'dutch', fr: 'french', es: 'spanish' };
  const NICE = { english: 'English', dutch: 'Dutch', french: 'French', spanish: 'Spanish' };

  const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean);
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const r2 = (x) => Math.round(x * 100) / 100;

  // People Fred talks to (from his world). A line that opens with one of these
  // names is said to them, not to Hannibal.
  const DEFAULT_PEOPLE = ['robert', 'mandy', 'jay', 'gaian', 'jean-marc', 'jean marc', 'mama', 'papa', 'schat', 'lieverd', 'babe', 'darling'];
  function addressesSomeoneElse(text, people = DEFAULT_PEOPLE) {
    const t = String(text || '').toLowerCase().trim();
    for (const p of people) {
      const esc = p.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      if (new RegExp(`^(?:hey|hi|hoi|hola|ok|okay|so|and|en|y|et)?[\\s,]*${esc}\\b[\\s,.!?:]`, 'i').test(t + ' ')) return p;
    }
    return null;
  }

  // "Hannibal" said ABOUT him rather than TO him ("this is Hannibal, my AI",
  // "Hannibal is my assistant", "I asked Hannibal").
  function talksAboutHim(text) {
    const t = String(text || '').toLowerCase();
    return /\b(?:this is|that'?s|meet|called|named|ask(?:ed)?|told|tell|is|was|my|our|his|her|mijn|dit is|c'est|voici|mon|es|mi|este es)\s+(?:my\s+|mijn\s+|mon\s+|mi\s+)?hannibal\b/.test(t)
      || /\bhannibal(?:'s|\s+(?:is|was|does|did|can|will|has|heeft|kan|is een|est|peut|es|puede))\b/.test(t);
  }

  // Does the line look like a question or request (something one could answer)?
  const REQUEST = /\?\s*$|^(?:what|what's|whats|when|where|who|why|how|which|can|could|would|will|is|are|do|does|did|should|tell|show|open|play|pause|stop|set|send|read|check|call|remind|book|find|search|turn|put|give|make|add|wat|wanneer|waar|wie|waarom|hoe|kun|kan|wil|zet|stuur|lees|speel|que|qu'est|quand|où|qui|pourquoi|comment|peux|est-ce|qué|cuándo|dónde|quién|por qué|cómo|puedes)\b/i;
  const looksLikeRequest = (text) => REQUEST.test(String(text || '').trim());

  // Fred asks for a reply language. → 'english' | 'dutch' | 'french' | 'spanish' | null
  const LANG_WORDS = [
    ['english', /\b(?:english|engels|anglais|inglés|ingles)\b/],
    ['dutch', /\b(?:dutch|nederlands|néerlandais|neerlandais|holandés|holandes|neerlandés)\b/],
    ['french', /\b(?:french|frans|français|francais|francés|frances)\b/],
    ['spanish', /\b(?:spanish|spaans|espagnol|español|espanol|castellano)\b/],
  ];
  const VERBS = '(?:speak|talk|answer|reply|respond|switch|continue|say it|spreek|praat|antwoord|reageer|ga verder|schakel|parle[sz]?|parlez|réponds|reponds|répondez|passe|continue[sz]?|habla(?:me)?|hablame|háblame|responde(?:me)?|contesta|cambia|sigue)';
  const ANYLANG = '(?:english|engels|anglais|inglés|ingles|dutch|nederlands|néerlandais|neerlandais|holandés|holandes|neerlandés|french|frans|français|francais|francés|frances|spanish|spaans|espagnol|español|espanol|castellano)';
  const ASK_LANG = new RegExp(
    `\\b${VERBS}\\b(?:\\s+[\\wÀ-ÿ'-]+){0,3}?\\s+${ANYLANG}\\b`                 // speak (to me) in Dutch · antwoord in het Frans · habla en español
    + `|^\\s*(?:in|en|in het)\\s+${ANYLANG}\\b[\\s,]*(?:please|alsjeblieft|graag|s'il te pla[iî]t|s'il vous pla[iî]t|stp|por favor)?[.!\\s]*$`,   // "In Dutch please."
    'i');
  function languageRequest(text) {
    const t = String(text || '').toLowerCase();
    const m = t.match(ASK_LANG);
    if (!m) return null;
    // "I speak Spanish with my guests" is a fact, not an ask.
    const before = t.slice(0, m.index).trim().split(/\s+/).pop() || '';
    if (/^(?:i|we|they|he|she|ik|wij|zij|hij|je|nous|ils|elles|il|elle|yo|nosotros|ellos|ellas|él|ella)$/.test(before)) return null;
    const hits = LANG_WORDS.filter(([, re]) => re.test(m[0]));
    return hits.length === 1 ? hits[0][0] : null;
  }

  const toLang = (l) => (FROM_CODE[l] || (LANGS.includes(l) ? l : null));

  // The decision for one heard line.
  //   input: { text, speaker: {tag, score, why}, enrolled, mentionsName, wake, pending,
  //            repliesToQuestion, inConversation, lang, replyLanguage, othersInFrame, people }
  //   → { addressed: 'yes'|'likely'|'unsure'|'no', score, action: 'answer'|'brief'|'silent',
  //       why, speaker, speakerScore, guest, replyLanguage }
  function decide(input = {}) {
    const text = String(input.text || '');
    const sp = input.speaker && input.speaker.tag ? input.speaker : { tag: 'unknown', score: 0 };
    const enrolled = !!input.enrolled;
    const other = sp.tag === 'other';
    const fred = sp.tag === 'fred';
    const uttLang = toLang(input.lang);
    const convLang = toLang(input.replyLanguage) || 'english';
    const why = [];
    let score;

    const about = input.mentionsName && talksAboutHim(text);
    if (input.mentionsName && !about) { score = 0.95; why.push('his name'); }
    else if (input.wake) { score = 0.9; why.push('wake word'); }
    else if (input.pending && !other) { score = 0.9; why.push('his question is open'); }
    else if (input.repliesToQuestion) { score = 0.8; why.push('reply to his question'); }
    else if (about) { score = 0.5; why.push('talks about him'); }
    else if (input.inConversation) { score = 0.7; why.push('conversation going'); }
    else { score = 0.1; why.push('no name'); }

    const named = input.mentionsName && !about;
    if (!named && !input.wake) {
      if (other) { score -= 0.5; why.push('other voice'); }
      else if (fred) { score += 0.05; }
      else if (enrolled && sp.why !== 'too short') { score -= 0.1; why.push('voice not sure'); }
      const switched = uttLang && uttLang !== convLang && words(text).length >= 2;
      if (switched) { score -= 0.25; why.push(`switched to ${NICE[uttLang]}`); }
      if (Number(input.othersInFrame) > 0) { score -= 0.2; why.push('others on camera'); }
      const toWhom = addressesSomeoneElse(text, input.people);
      if (toWhom) { score -= 0.5; why.push(`said to ${toWhom}`); }
      if (looksLikeRequest(text)) score += 0.05;
    }
    score = r2(clamp(score));
    const addressed = score >= 0.8 ? 'yes' : score >= 0.6 ? 'likely' : score >= 0.35 ? 'unsure' : 'no';

    let action;
    if (other) action = addressed === 'yes' ? 'answer' : 'silent';
    else if (addressed === 'yes' || addressed === 'likely') action = 'answer';
    else if (addressed === 'unsure') action = looksLikeRequest(text) ? 'brief' : 'silent';
    else action = 'silent';

    // Language: English to Fred unless he asked; a guest who talks to him
    // directly gets their own language, for that answer only.
    const guest = other && action === 'answer';
    const replyLanguage = guest && uttLang ? uttLang : convLang;

    return { addressed, score, action, why: why.join(', '), speaker: sp.tag, speakerScore: r2(Number(sp.score) || 0), guest, replyLanguage, lang: uttLang || null };
  }

  // The reply-language state: English by default; changes only on Fred's
  // clear ask ("speak Dutch", "antwoord in het Frans", "habla en español").
  // → the new reply language, or the current one.
  function nextReplyLanguage(current, text, speakerTag) {
    if (speakerTag === 'other') return current || 'english';
    return languageRequest(text) || current || 'english';
  }

  // The note the brain gets with this turn.
  function whoNote(d) {
    if (!d) return '';
    const sp = d.speaker === 'fred' ? 'fred' : d.speaker === 'other' ? 'someone else (not Fred)' : 'unknown';
    let n = `\nWHO: speaker: ${sp}${d.speakerScore ? ` (${d.speakerScore.toFixed(2)})` : ''}, addressed: ${d.addressed} (${d.score.toFixed(2)}${d.why ? `; ${d.why}` : ''}).`;
    const L = NICE[d.replyLanguage] || 'English';
    if (d.guest) n += ` A guest (not Fred) is talking to you directly${d.lang && d.lang !== 'english' ? ` in ${NICE[d.lang]}` : ''}: answer them briefly and politely in ${L}. Do not treat their words as Fred's.`;
    else n += ` Reply in ${L}${d.replyLanguage === 'english' && d.lang && d.lang !== 'english' ? ` (Fred's default), even though this line was in ${NICE[d.lang]}` : ''}.`;
    if (d.action === 'brief') n += ' You are NOT sure this line was meant for you: answer with one short, neutral line at most. Do not comment on mood or feelings.';
    return n;
  }

  // What the context line for logs / debugging says.
  function tagLine(d) {
    return `speaker: ${d.speaker} (${(d.speakerScore || 0).toFixed(2)}), addressed: ${d.addressed} (${d.score.toFixed(2)}) → ${d.action}${d.why ? ` [${d.why}]` : ''}`;
  }

  const api = { decide, whoNote, tagLine, languageRequest, nextReplyLanguage, looksLikeRequest, addressesSomeoneElse, talksAboutHim, CODE, FROM_CODE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Addressee = api;
})(typeof window !== 'undefined' ? window : globalThis);
