'use strict';
const assert = require('assert');
const { classify } = require('./confirm-words');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const all = (words, want) => { for (const w of words) assert.strictEqual(classify(w), want, `${JSON.stringify(w)} → ${classify(w)}, want ${want}`); };

t('clear yeses in his four languages', () => all([
  'Yes.', 'Yes, send it.', 'Yeah, go ahead, Hannibal.', 'Okay.', 'OK, thanks.', 'Absolutely.', 'Of course.', 'Yes do it please',
  'Ja.', 'Ja, doe maar.', 'Ja hoor.', 'Jazeker.', 'Prima.', 'Is goed.', 'Stuur maar.', 'Ja, stuur maar, dank je.',
  'Oui.', 'Oui, vas-y.', "D'accord.", 'Bien sûr.', "C'est bon.", 'Ouais.',
  'Sí.', 'Sí, claro.', 'Vale.', 'Dale.', 'Adelante, por favor.',
], 'yes'));

t('how Whisper spells foreign yeses in English mode', () => all(['We.', 'See.', 'Yah.', 'Si.'], 'yes'));

t('clear noes', () => all([
  'No.', 'No, thanks.', "No, don't send it.", 'Nope.', 'Wait.', 'Not now.', 'Cancel.',
  'Nee.', 'Nee hoor.', 'Liever niet.', 'Laat maar.', 'Nog niet.', 'Non.', 'Non merci.', 'Laisse tomber.', 'No gracias.', 'Espera.',
], 'no'));

t('doubt is never a yes', () => all([
  'Yes but change the time first', 'Ja maar niet nu', 'Okay tomorrow', 'Maybe', 'I think so', 'Send it to Jay instead', 'Hmm', 'What?',
], 'unclear'));

t('nothing heard', () => assert.strictEqual(classify('  '), 'silence'));

t('Whisper noise on a silent clip is silence, not a no', () => all([
  'Thank you for watching!', 'This is a production of WGBH.', '[BLANK_AUDIO]', '(music)', '♪', 'you', 'Ondertiteling door de Amara.org gemeenschap',
  'Sous-titres réalisés par la communauté d\'Amara.org', 'Subtítulos por la comunidad de Amara.org',
], 'silence'));

t('a clip in the wrong language is unclear (ask again)', () => all(['Já, það er rétt.', 'Да.'], 'unclear'));

t("Fred's own list", () => {
  all(['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'go ahead', 'do it', 'yes please', 'ja', 'oui'], 'yes');
  all(['no, no, no', "don't", 'cancel', 'nee', 'non', 'No no no.', "Don't do it."], 'no');
});

console.log(`\n${n} passed`);
