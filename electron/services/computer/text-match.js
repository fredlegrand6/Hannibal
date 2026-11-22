// Find the on-screen thing Fred means by its text (computer.clickText), from
// accessibility items and OCR lines. Pure; tested in test-computer.js.
'use strict';

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[“”"'’‘`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// 0..1: how well `label` matches `query`. Exact beats starts-with beats word
// match beats contains; a long label that merely contains the words scores low.
function score(label, query) {
  const l = norm(label), q = norm(query);
  if (!l || !q) return 0;
  if (l === q) return 1;
  const lw = l.split(' '), qw = q.split(' ');
  if (l.startsWith(q + ' ') || l.endsWith(' ' + q)) return 0.85 - Math.min(0.3, (lw.length - qw.length) * 0.05);
  const idx = ` ${l} `.indexOf(` ${q} `);
  if (idx >= 0) return 0.7 - Math.min(0.4, (lw.length - qw.length) * 0.04);
  if (l.includes(q)) return q.length >= 4 ? 0.45 - Math.min(0.25, (l.length - q.length) / 200) : 0;
  // every query word appears (any order)
  if (qw.length > 1 && qw.every((w) => lw.includes(w))) return 0.5;
  return 0;
}

const CLICKABLE = new Set(['AXButton', 'AXLink', 'AXMenuItem', 'AXMenuBarItem', 'AXCheckBox', 'AXRadioButton', 'AXPopUpButton',
  'AXMenuButton', 'AXTab', 'AXCell', 'AXRow', 'AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox', 'AXImage', 'AXStaticText', 'AXDisclosureTriangle']);

// AX items from the helper ({ role, title, description, value, frame }) → ranked candidates.
function rankAx(items, query) {
  const out = [];
  for (const it of items || []) {
    const f = it.frame;
    if (!f || f.w < 2 || f.h < 2) continue;                // collapsed / off-screen element
    const labels = [it.title, it.description, it.placeholder, it.role === 'AXStaticText' || it.role === 'AXButton' || it.role === 'AXLink' ? it.value : '', it.help];
    let best = 0, label = '';
    for (const lab of labels) { const s = score(lab, query); if (s > best) { best = s; label = lab; } }
    if (best <= 0) continue;
    if (CLICKABLE.has(it.role) && it.role !== 'AXStaticText') best += 0.08;   // prefer the real control
    out.push({ source: 'ax', score: Math.min(1.08, best), label, role: it.role,
      rect: { x: f.x, y: f.y, width: f.w, height: f.h }, center: { x: f.x + f.w / 2, y: f.y + f.h / 2 } });
  }
  return out.sort((a, b) => b.score - a.score);
}

// OCR lines already mapped to global ({ text, conf, rect, center, display }) → ranked.
// A query that is one word of a longer line ("Send" in "Send  Cancel") points
// at that word's slice of the line, estimated from character positions.
function rankOcr(lines, query) {
  const q = norm(query);
  const out = [];
  for (const ln of lines || []) {
    let s = score(ln.text, query);
    if (s <= 0) continue;
    if ((ln.conf || 1) < 0.4) s *= 0.7;
    let rect = ln.rect, center = ln.center;
    const t = norm(ln.text);
    const i = t.indexOf(q);
    if (i > 0 || (i === 0 && q.length < t.length)) {
      const per = ln.rect.width / Math.max(1, t.length);
      rect = { x: ln.rect.x + i * per, y: ln.rect.y, width: Math.max(8, q.length * per), height: ln.rect.height };
      center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    out.push({ source: 'ocr', score: s, label: ln.text, rect, center, display: ln.display });
  }
  return out.sort((a, b) => b.score - a.score);
}

// Pick one, or say it is ambiguous. index (1-based) picks the Nth best.
function choose(cands, { index } = {}) {
  const good = cands.filter((c) => c.score >= 0.45);
  if (!good.length) return { found: false, near: cands.slice(0, 5).map((c) => c.label) };
  if (index) {
    const c = good[Number(index) - 1];
    return c ? { found: true, target: c } : { found: false, near: good.slice(0, 8).map((x) => x.label) };
  }
  const top = good[0];
  // Several equally good matches far apart (two "Send" buttons) → let Fred / Claude pick.
  const ties = good.filter((c) => c.score >= top.score - 0.02
    && (Math.abs(c.center.x - top.center.x) > 12 || Math.abs(c.center.y - top.center.y) > 12));
  if (ties.length) {
    const all = [top, ...ties].slice(0, 6);
    return { found: false, ambiguous: true, options: all.map((c, i) => ({ index: i + 1, label: c.label, display: c.display, at: { x: Math.round(c.center.x), y: Math.round(c.center.y) } })) };
  }
  return { found: true, target: top };
}

module.exports = { score, rankAx, rankOcr, choose, norm };
