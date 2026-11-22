// Key names → macOS virtual key codes + modifiers, for computer.key.
//   parseCombo("cmd+shift+v") → { code: 9, mods: ['cmd','shift'], name: 'v', label: 'cmd+shift+v' }
//   parseKeys("cmd+a, delete") → [combo, combo]   (a short sequence, pressed in order)
'use strict';

const CODES = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, 1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, '=': 24, 9: 25, 7: 26, '-': 27, 8: 28, 0: 29,
  ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, return: 36, l: 37, j: 38, "'": 39, k: 40, ';': 41,
  '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, tab: 48, space: 49, '`': 50, delete: 51,
  escape: 53, forwarddelete: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

const KEY_ALIASES = {
  enter: 'return', '↩': 'return', '⏎': 'return', ret: 'return',
  esc: 'escape', backspace: 'delete', bksp: 'delete', '⌫': 'delete', del: 'forwarddelete', '⌦': 'forwarddelete',
  spacebar: 'space', ' ': 'space', arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down',
  pgup: 'pageup', pgdn: 'pagedown', plus: '=', minus: '-', comma: ',', period: '.', dot: '.', slash: '/',
};
const MOD_ALIASES = {
  cmd: 'cmd', command: 'cmd', '⌘': 'cmd', meta: 'cmd', super: 'cmd', win: 'cmd',
  shift: 'shift', '⇧': 'shift',
  alt: 'alt', option: 'alt', opt: 'alt', '⌥': 'alt',
  ctrl: 'ctrl', control: 'ctrl', ctl: 'ctrl', '⌃': 'ctrl',
  fn: 'fn',
};
const MOD_ORDER = ['ctrl', 'alt', 'shift', 'cmd', 'fn'];

function parseCombo(input) {
  let raw = String(input || '').trim().toLowerCase();
  if (!raw) throw new Error('no key given');
  // "cmd+v", "cmd-v", "Command V", "⌘V" all work; a lone "+" or "-" is the key itself.
  if (raw.length > 1) raw = raw.replace(/⌘/g, 'cmd+').replace(/⇧/g, 'shift+').replace(/⌥/g, 'alt+').replace(/⌃/g, 'ctrl+');
  const parts = raw.length === 1 ? [raw] : raw.split(/\s*\+\s*|\s+|(?<=[a-z])-(?=.)/).filter(Boolean);
  const mods = new Set();
  let key = null;
  for (const p of parts) {
    if (MOD_ALIASES[p]) { mods.add(MOD_ALIASES[p]); continue; }
    if (key) throw new Error(`"${input}" has two keys (${key} and ${p}); press them one after the other instead`);
    key = KEY_ALIASES[p] || p;
  }
  if (!key) throw new Error(`"${input}" has only modifiers, no key`);
  if (!(key in CODES)) throw new Error(`unknown key "${key}"`);
  const m = MOD_ORDER.filter((x) => mods.has(x));
  return { code: CODES[key], mods: m, name: key, label: [...m, key].join('+') };
}

// A comma-separated short sequence: "cmd+a, delete" or ["cmd+a", "delete"].
function parseKeys(keys) {
  const list = Array.isArray(keys) ? keys : String(keys || '').split(/\s*,\s*|\s+then\s+/i);
  const combos = list.map((k) => String(k).trim()).filter(Boolean).map(parseCombo);
  if (!combos.length) throw new Error('no keys given');
  if (combos.length > 8) throw new Error('too many keys in one go (max 8)');
  return combos;
}

module.exports = { parseCombo, parseKeys, CODES };
