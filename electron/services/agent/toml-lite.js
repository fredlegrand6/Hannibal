// ─────────────────────────────────────────────────────────────────────────
// toml-lite — a tiny, dependency-free TOML reader for the skill format.
//
// Hannibal carries no third-party deps (just ws + electron), so rather than pull
// a TOML library we parse the constrained subset the skill schema actually uses:
//   • tables            [skill]
//   • array-of-tables   [[skill.steps]]   [[skill.params]]
//   • key = value where value is: a basic string "…" (with \n \t \" \\ escapes),
//     a multi-line basic string """…""", an integer/float, true/false, an array
//     [a, b, c], or an inline table { k = v, k2 = v2 }
//   • # full-line comments and trailing comments after scalar values
// It is NOT a general TOML parser — it's exactly enough for data/skills/*.toml,
// and it throws on anything it can't read so a malformed skill fails honestly.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

function unescapeChar(c) {
  switch (c) {
    case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r';
    case '"': return '"'; case '\\': return '\\'; default: return c;
  }
}

// Split into logical lines, absorbing the newlines INSIDE """triple""" strings
// (so a multi-line value stays on one logical line). Normal strings must not
// contain raw newlines (use \n), which matches how the skill files are written.
function splitLogicalLines(text) {
  const lines = [];
  let buf = '', i = 0;
  while (i < text.length) {
    if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      const stop = end === -1 ? text.length : end + 3;
      buf += text.slice(i, stop);
      i = stop;
      continue;
    }
    const ch = text[i];
    if (ch === '\n') { lines.push(buf); buf = ''; i += 1; continue; }
    buf += ch; i += 1;
  }
  if (buf.length) lines.push(buf);
  return lines;
}

// Consume exactly ONE value token from the front of `str`. Returns {value, rest};
// `rest` is whatever follows (a trailing comment for scalars, or the next token
// inside an array/inline table). Recurses for arrays and inline tables.
function scanValue(str) {
  str = str.replace(/^\s+/, '');
  if (str.startsWith('"""')) {
    const end = str.indexOf('"""', 3);
    if (end === -1) throw new Error('unterminated """ string');
    let body = str.slice(3, end);
    if (body.startsWith('\n')) body = body.slice(1);          // TOML trims one leading newline
    return { value: applyEscapes(body), rest: str.slice(end + 3) };
  }
  if (str[0] === '"') {
    let i = 1, out = '';
    while (i < str.length) {
      if (str[i] === '\\') { out += unescapeChar(str[i + 1]); i += 2; continue; }
      if (str[i] === '"') { i += 1; break; }
      out += str[i]; i += 1;
    }
    return { value: out, rest: str.slice(i) };
  }
  if (str[0] === '[') {
    let i = 1; const arr = [];
    for (;;) {
      while (i < str.length && /[\s,]/.test(str[i])) i += 1;
      if (str[i] === ']') { i += 1; break; }
      if (i >= str.length) throw new Error('unterminated array');
      const r = scanValue(str.slice(i));
      arr.push(r.value);
      i += (str.length - i) - r.rest.length;
    }
    return { value: arr, rest: str.slice(i) };
  }
  if (str[0] === '{') {
    let i = 1; const obj = {};
    for (;;) {
      while (i < str.length && /[\s,]/.test(str[i])) i += 1;
      if (str[i] === '}') { i += 1; break; }
      if (i >= str.length) throw new Error('unterminated inline table');
      const sub = str.slice(i);
      const eq = sub.indexOf('=');
      if (eq === -1) throw new Error('inline table entry missing =');
      const key = sub.slice(0, eq).trim();
      const r = scanValue(sub.slice(eq + 1));
      obj[key] = r.value;
      i += sub.length - r.rest.length;
    }
    return { value: obj, rest: str.slice(i) };
  }
  // scalar: number | boolean | bareword string, up to a delimiter/comment
  const m = str.match(/^[^,}\]\s#]+/);
  const tok = m ? m[0] : '';
  let value;
  if (tok === 'true') value = true;
  else if (tok === 'false') value = false;
  else if (/^[+-]?\d+$/.test(tok)) value = parseInt(tok, 10);
  else if (/^[+-]?(?:\d*\.\d+|\d+\.\d*)$/.test(tok)) value = parseFloat(tok);
  else value = tok;
  return { value, rest: str.slice(tok.length) };
}

function applyEscapes(s) {
  return s.replace(/\\(.)/g, (_, c) => unescapeChar(c));
}

function ensureTable(root, pathParts) {
  let cur = root;
  for (const p of pathParts) {
    if (typeof cur[p] !== 'object' || cur[p] === null || Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  return cur;
}

function pushArrayTable(root, pathParts) {
  const parent = ensureTable(root, pathParts.slice(0, -1));
  const key = pathParts[pathParts.length - 1];
  if (!Array.isArray(parent[key])) parent[key] = [];
  const t = {};
  parent[key].push(t);
  return t;
}

function parse(text) {
  const root = {};
  let current = root;
  for (const logical of splitLogicalLines(text)) {
    const line = logical.trim();
    if (!line || line[0] === '#') continue;
    if (line.startsWith('[[')) {
      const end = line.indexOf(']]');
      if (end === -1) throw new Error('malformed [[array-of-tables]] header');
      current = pushArrayTable(root, line.slice(2, end).trim().split('.'));
    } else if (line[0] === '[') {
      const end = line.indexOf(']');
      if (end === -1) throw new Error('malformed [table] header');
      current = ensureTable(root, line.slice(1, end).trim().split('.'));
    } else {
      const eq = line.indexOf('=');
      if (eq === -1) throw new Error(`expected key = value, got: ${line.slice(0, 40)}`);
      const key = line.slice(0, eq).trim();
      current[key] = scanValue(line.slice(eq + 1)).value;
    }
  }
  return root;
}

module.exports = { parse, scanValue, splitLogicalLines };
