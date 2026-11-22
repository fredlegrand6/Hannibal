// ─────────────────────────────────────────────────────────────────────────
// CONFIRM WORDS — is Fred's answer to "send it?" a clear yes, a no, or neither?
//
// Deny by default: only a clean affirmative is a yes. But Fred answers in
// English, Dutch, French and Spanish, and Whisper writes short foreign words
// the way they sound in English ("oui" → "We.", "sí" → "See.", "ja" → "Yah"),
// so those spellings count too. Anything with a doubt in it ("yes but…",
// "wait") is not a yes.
// ─────────────────────────────────────────────────────────────────────────
(function (root) {
  'use strict';

  // Clean yeses, alone or chained ("yes, send it, Hannibal").
  const YES = [
    // English
    'yes please', 'please', 'yes', 'yeah', 'yep', 'yup', 'yah', 'ya', 'yes sir', 'sure', 'ok', 'okay', 'o\\.?k\\.?', 'alright', 'all right',
    'do it', 'send it', 'send that', 'send', 'book it', 'book that', 'booked', 'book', 'delete it please', 'delete it', 'delete that', 'deleted', 'delete',
    'remove it', 'move it', 'move that', 'moved', 'move', 'go ahead', 'go for it', 'go', 'confirm', 'confirmed', 'approve', 'approved',
    'affirmative', 'absolutely', 'of course', 'certainly', 'correct', "that's right", 'exactly', 'uh-huh', 'mm-hmm', 'yes do it',
    // Dutch
    'ja hoor', 'jazeker', 'ja', 'jah', 'jawel', 'zeker', 'doe maar', 'graag', 'prima', 'oké', 'okee', 'is goed', 'goed', 'prima zo',
    'stuur maar', 'stuur het', 'verstuur', 'versturen', 'stuur', 'verwijder maar', 'verwijderen', 'verwijder', 'verplaats', 'boek maar', 'boek het',
    // French
    'oui oui', 'oui', 'ouais', 'we', 'wee', "d'accord", "d'acc", 'bien sûr', 'vas-y', 'vas y', 'allez', "c'est bon", 'parfait', 'envoie', 'envoie-le',
    'supprime-le', 'supprime', 'efface', 'déplace',
    // Spanish
    'sí claro', 'sí', 'si', 'see', 'claro', 'vale', 'dale', 'venga', 'perfecto', 'por supuesto', 'envíalo', 'envialo', 'adelante',
  ];
  // Words that may follow a yes without adding doubt.
  const FILLER = [
    'please', 'thanks', 'thank you', 'hannibal', "that's fine", 'that is fine', 'fine', 'perfect', 'great', 'good', 'sure',
    'dank je', 'dank je wel', 'bedankt', 'merci', 'gracias', 'por favor', "s'il te plaît", 'alsjeblieft', 'now', 'nu',
  ];
  const NO = [
    'no thanks', 'no thank you', 'no', 'nope', 'nah', 'no no', "don't", 'do not', 'stop', 'cancel', 'wait', 'hold on', 'hold up',
    'never mind', 'nevermind', 'negative', 'skip', 'not now', 'leave it', 'abort', 'not yet',
    'nee', 'nee hoor', 'nee dank je', 'niet', 'liever niet', 'nog niet', 'wacht', 'stop maar', 'annuleer', 'laat maar', 'nay',
    'non', 'non merci', 'pas maintenant', 'attends', 'annule', 'laisse tomber',
    'no gracias', 'espera', 'cancela', 'déjalo', 'dejalo', 'todavía no', 'nein',
  ];
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '\\' ? c : '\\' + c));
  const alt = (list) => list.map((w) => (/\\/.test(w) ? w : esc(w))).sort((a, b) => b.length - a.length).join('|');
  const YES_ONE = new RegExp(`^(${alt(YES)})$`, 'i');
  const NO_ONE = new RegExp(`^(${alt(NO)})$`, 'i');
  const YES_HEAD = new RegExp(`^(${alt(YES)})(?=\\s|$)`, 'i');
  const YES_TAIL = new RegExp(`^(${alt([...YES, ...FILLER])})(?=\\s|$)`, 'i');

  // What Whisper writes for a silent or noisy clip. That is nobody answering,
  // so it is treated as silence (ask again), never as a no.
  const NOISE = /^(?:\[.*\]|\(.*\)|♪+|you|bye|thank you|thanks|thank you for watching|thanks for watching|please subscribe|subtitles? by.*|.*amara\.org.*|this is a production of.*|.*wgbh.*|ondertiteling.*|ondertiteld door.*|sous-titres?.*|sous-titrage.*|subtítulos.*|subtitulado.*|merci d'avoir regardé.*|bedankt voor het kijken.*|gracias por ver.*)$/i;
  // Letters none of his four languages use (Icelandic þ/ð, Cyrillic, CJK...):
  // the clip was misheard, so ask again.
  const FOREIGN = /[þðæøåßłœ\u0400-\u04ff\u0370-\u03ff\u0590-\u06ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/i;

  function classify(raw) {
    let t = String(raw || '').toLowerCase().replace(/[“”"]/g, '').trim();
    if (NOISE.test(t.replace(/[.!?,]+$/g, '').trim())) return 'silence';
    if (FOREIGN.test(t)) return 'unclear';
    t = t.replace(/[,.!?;:¡¿]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return 'silence';
    t = t.replace(/^((uh|um|uhm|eh|ehm|oh|ah|euh|hmm)\s+)+/, '');
    if (YES_ONE.test(t)) return 'yes';
    if (NO_ONE.test(t)) return 'no';
    // A no at the start wins ("no, don't send it", "nee, laat maar").
    const firstWords = t.split(' ').slice(0, 2).join(' ');
    if (NO_ONE.test(t.split(' ')[0]) || NO_ONE.test(firstWords)) return 'no';
    // A yes followed only by more yeses or filler.
    let m = YES_HEAD.exec(t);
    if (!m) return 'unclear';
    let rest = t.slice(m[0].length).trim();
    while (rest) {
      m = YES_TAIL.exec(rest);
      if (!m) return 'unclear';
      rest = rest.slice(m[0].length).trim();
    }
    return 'yes';
  }

  const api = { classify };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ConfirmWords = api;
})(typeof window !== 'undefined' ? window : globalThis);
