// SAFETY RULES for Hannibal's hands (computer.* tools). Pure functions, tested
// in electron/services/computer/test-computer.js.
//
//   • risky targets: a click on Send / Delete / Pay / Submit / Merge … (EN, NL,
//     FR, ES) goes through the voice yes/no gate first;
//   • keys and typing that send, submit, delete or run a command are gated too
//     (Enter in a chat app or Terminal, cmd+Enter, Delete outside a text box…);
//   • protected apps (System Settings, Keychain, password managers) are off
//     limits unless Fred explicitly asked, and then still gated;
//   • passwords / secrets are never typed unless Fred explicitly said so, and
//     never written to the log.
'use strict';

// Words that make a button or link "consequential". Matched as whole words on
// SHORT labels only (a button, not a paragraph that happens to say "send").
const RISKY = [
  // English
  'send', 'send now', 'send message', 'reply all', 'post', 'publish', 'tweet', 'submit', 'confirm', 'delete', 'delete forever',
  'remove', 'trash', 'move to trash', 'empty trash', 'erase', 'discard', 'pay', 'pay now', 'buy', 'buy now', 'purchase',
  'order', 'place order', 'checkout', 'check out', 'subscribe', 'donate', 'transfer', 'merge', 'squash and merge',
  'rebase and merge', 'push', 'force push', 'deploy', 'approve', 'sign', 'sign and send', 'install', 'uninstall',
  'unsubscribe', 'run', 'execute', 'book', 'book now', 'reserve', 'accept', 'withdraw',
  // Dutch
  'verstuur', 'versturen', 'verzend', 'verzenden', 'plaatsen', 'publiceren', 'indienen', 'bevestig', 'bevestigen',
  'verwijder', 'verwijderen', 'wissen', 'prullenmand', 'betaal', 'betalen', 'nu betalen', 'afrekenen', 'bestel', 'bestellen',
  'koop', 'kopen', 'overmaken', 'samenvoegen', 'ondertekenen', 'boeken', 'reserveren', 'installeren', 'uitvoeren',
  // French
  'envoyer', 'envoie', 'publier', 'soumettre', 'valider', 'confirmer', 'supprimer', 'effacer', 'corbeille', 'payer',
  'acheter', 'commander', 'fusionner', 'signer', 'virement', 'réserver', 'installer', 'exécuter',
  // Spanish
  'enviar', 'publicar', 'confirmar', 'eliminar', 'borrar', 'papelera', 'pagar', 'comprar', 'realizar pedido', 'pedir',
  'fusionar', 'firmar', 'transferir', 'reservar', 'instalar', 'ejecutar',
];
const RISKY_RE = new RegExp(`(?:^|[^\\p{L}])(${RISKY.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})(?=$|[^\\p{L}])`, 'iu');
const MAX_LABEL = 48;

// Is this label (button title, link text, the text Fred asked to click) a
// consequential action? → { risky:true, word } | { risky:false }
function riskyLabel(label) {
  const s = String(label || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > MAX_LABEL) return { risky: false };
  const m = s.match(RISKY_RE);
  return m ? { risky: true, word: m[1].toLowerCase() } : { risky: false };
}

// The labels worth checking for one element the accessibility API reported.
function labelsOf(el) {
  if (!el || typeof el !== 'object') return [];
  const pick = (e) => (e ? [e.title, e.description, e.help, e.role === 'AXButton' || e.role === 'AXLink' ? e.value : ''] : []);
  return [...pick(el.control), ...pick(el)].map((s) => String(s || '').trim()).filter(Boolean);
}
function riskyElement(el, nearbyText) {
  for (const l of [...labelsOf(el), ...(Array.isArray(nearbyText) ? nearbyText : [])]) {
    const r = riskyLabel(l);
    if (r.risky) return { ...r, label: l };
  }
  return { risky: false };
}

// ── protected apps ──
const PROTECTED_RE = /\b(system settings|system preferences|systeeminstellingen|systeemvoorkeuren|réglages système|préférences système|ajustes del sistema|preferencias del sistema|keychain access|sleutelhangertoegang|trousseau d'accès|acceso a llaveros|passwords|wachtwoorden|mots de passe|contraseñas|1password|bitwarden|lastpass|dashlane|keeper|enpass|keepassxc?|nordpass|proton pass|roboform)\b/i;
const PROTECTED_BUNDLES = /^(com\.apple\.systempreferences|com\.apple\.Settings|com\.apple\.keychainaccess|com\.apple\.Passwords|com\.1password\.|com\.agilebits\.|com\.bitwarden\.|com\.lastpass\.|com\.dashlane\.|com\.callpod\.keeper|in\.sinew\.Enpass|org\.keepassxc\.|com\.nordpass\.|me\.proton\.pass)/i;
function protectedApp(name, bundle) {
  return PROTECTED_RE.test(String(name || '')) || PROTECTED_BUNDLES.test(String(bundle || ''));
}

// ── app classes for keys ──
const TERMINAL_RE = /\b(terminal|iterm2?|warp|alacritty|kitty|wezterm|hyper|ghostty|tabby)\b/i;
// Apps where Enter just makes a new line / confirms an edit (no send, no submit).
const EDITOR_RE = /^(notes|notities|notes\.app|textedit|teksteditor|pages|microsoft word|word|numbers|microsoft excel|excel|keynote|stickies|cursor|visual studio code|code|xcode|sublime text|zed|bbedit|nova|obsidian|finder|reminders|herinneringen|rappels|recordatorios|calculator|rekenmachine|preview|voorvertoning|bear|craft|notion|google docs)$/i;

const isTerminal = (app) => TERMINAL_RE.test(String(app || ''));
const isEditor = (app) => EDITOR_RE.test(String(app || '').trim());
const TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField']);
const isTextBox = (el) => !!el && (TEXT_ROLES.has(el.role) || el.subrole === 'AXSearchField');

// Does pressing this combo need Fred's yes first? ctx: { app, bundle, element }
// → null (fine) or a short reason ("may send or submit in Messages").
function keyNeedsGate(combo, ctx = {}) {
  const app = ctx.app || 'the front app';
  const m = new Set(combo.mods || []);
  const k = combo.name;
  if (k === 'return' && (m.has('cmd') || m.has('ctrl'))) return `${combo.label} usually sends or submits in ${app}`;
  if (k === 'd' && m.has('cmd') && m.has('shift')) return `${combo.label} sends the mail in ${app}`;
  if (k === 'q' && m.has('cmd')) return `${combo.label} quits ${app} (unsaved work can be lost)`;
  if (k === 'delete' && m.has('cmd') && m.has('shift')) return `${combo.label} empties the Trash`;
  if (k === 'return') {
    if (isTerminal(app)) return `Enter runs the command in ${app}`;
    if (isEditor(app) || isLauncher(app)) return null;   // a launcher's protected targets: stepGate
    return `Enter may send or submit in ${app}`;
  }
  if (k === 'delete' || k === 'forwarddelete') {
    if (m.has('cmd') && !isTextBox(ctx.element)) return `${combo.label} deletes the selected item in ${app}`;
    if (!m.has('cmd') && !isTextBox(ctx.element) && !isEditor(app) && !isTerminal(app)) return `${combo.label} may delete the selected item in ${app}`;
  }
  return null;
}

// ── focus changes inside a key sequence ──
// A combo can move Hannibal into another app, window or field (cmd+tab, cmd+`,
// Spotlight, a space switch, Tab …). Everything after it must be judged where
// it really lands, so it is re-checked at that moment, not up front.
function mayMoveFocus(combo) {
  const m = new Set(combo.mods || []);
  if (m.has('cmd') || m.has('ctrl')) return true;
  if (combo.name === 'tab') return true;
  if (/^f\d+$/.test(combo.name)) return true;   // F3 Mission Control, F4 Launchpad …
  return false;
}
// How many steps of a sequence can be judged on the context read before it:
// up to and including the first one that may move focus.
function stepsCheckable(combos) {
  const i = (combos || []).findIndex(mayMoveFocus);
  return i < 0 ? (combos || []).length : i + 1;
}

// Launchers (Spotlight, Raycast, Alfred …): Enter opens what is typed there.
const LAUNCHER_RE = /^(spotlight|raycast|alfred|launchbar)$/i;
const isLauncher = (app) => LAUNCHER_RE.test(String(app || '').trim());
// Would Enter in this launcher open a protected app?
function launcherOpensProtected(ctx = {}, text) {
  if (!isLauncher(ctx.app)) return false;
  const v = text != null ? text : (ctx.element && ctx.element.value);
  return PROTECTED_RE.test(String(v || ''));
}

// The full check for one key combo in one context, the same one a direct
// action gets. → null | { block } | { confirm: reason }
function stepGate(combo, ctx = {}, { explicit = false } = {}) {
  const prot = protectedApp(ctx.app, ctx.bundle) || (combo.name === 'return' && launcherOpensProtected(ctx));
  if (prot) {
    const what = protectedApp(ctx.app, ctx.bundle) ? ctx.app : 'a protected app (settings, keychain or passwords)';
    if (!explicit) return { block: `${combo.label} would act in ${what}. Hannibal does not touch settings, keychain or passwords unless Fred explicitly asks.` };
    return { confirm: `${combo.label} acts in ${what}` };
  }
  const r = keyNeedsGate(combo, ctx);
  return r ? { confirm: r } : null;
}

// Does typing this text need a yes? A newline is an Enter.
function typeNeedsGate(text, ctx = {}) {
  if (!/[\r\n]/.test(String(text || ''))) return null;
  const app = ctx.app || 'the front app';
  if (isTerminal(app)) return `the text has a new line, which runs it as a command in ${app}`;
  if (isEditor(app) || isLauncher(app)) return null;
  return `the text has a new line, which may send or submit it in ${app}`;
}

// ── secrets ──
const SECRET_PATTERNS = [
  /\bsk-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{16,}/g,             // Anthropic / OpenAI / Stripe style
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                                    // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                                              // AWS
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,                                    // Telegram bot token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,   // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:password|passwd|pwd|wachtwoord|mot de passe|contraseña|api[_ -]?key|secret|token)\s*[:=]\s*\S+/gi,
];
function entropy(s) {
  const f = {}; for (const c of s) f[c] = (f[c] || 0) + 1;
  return Object.values(f).reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
}
// One word that looks like a password or key (mixed character classes, no spaces).
function passwordLike(s) {
  const t = String(s || '').trim();
  if (!t || /\s/.test(t) || t.length < 8 || t.length > 128) return false;
  if (/^https?:\/\//i.test(t) || /^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t)) return false;   // a link or an email address
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(t)).length;
  if (t.length >= 20 && classes >= 3 && entropy(t) > 3.5) return true;    // a key / token
  return t.length <= 40 && classes === 4;                                  // a typical password
}
function looksSecret(text) {
  const s = String(text || '');
  if (SECRET_PATTERNS.some((re) => { re.lastIndex = 0; return re.test(s); })) return true;
  return passwordLike(s);
}
// Mask secrets for the log (and anything shown back).
function mask(text) {
  let s = String(text == null ? '' : text);
  for (const re of SECRET_PATTERNS) { re.lastIndex = 0; s = s.replace(re, (m) => `[secret, ${m.length} chars]`); }
  return s.split(/(\s+)/).map((w) => (passwordLike(w) ? `[secret, ${w.length} chars]` : w)).join('');
}

module.exports = {
  riskyLabel, riskyElement, labelsOf, protectedApp, keyNeedsGate, typeNeedsGate, stepGate, stepsCheckable, mayMoveFocus, isLauncher, launcherOpensProtected,
  looksSecret, mask, isTerminal, isEditor, isTextBox, RISKY,
};
