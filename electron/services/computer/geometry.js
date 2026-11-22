// SCREEN GEOMETRY for Hannibal's hands — Fred has 3 displays with different
// scaling (the MacBook's Retina at 2x, two 1080p Philips at 1x, one left and one
// right, both above the laptop). Everything here works in macOS GLOBAL POINTS
// (top-left of the main display is 0,0; y grows down; other displays can sit at
// negative x or y), which is what Electron's screen module, CGEvent and the
// accessibility API all use.
//
// Claude never does coordinate maths: it gets a screenshot of ONE display and
// answers with pixel coordinates in that image plus the display number. This
// module turns those back into global points.
'use strict';

// Electron's screen.getAllDisplays() → our numbered list, left to right.
// 1 = leftmost display. Each gets plain names Fred might say too.
function normalizeDisplays(list) {
  const ds = (Array.isArray(list) ? list : []).map((d) => ({
    id: d.id,
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    scaleFactor: d.scaleFactor || 1,
    internal: !!d.internal,
    label: d.label || '',
  }));
  const cx = (d) => d.bounds.x + d.bounds.width / 2;
  ds.sort((a, b) => cx(a) - cx(b) || a.bounds.y - b.bounds.y);
  ds.forEach((d, i) => {
    d.index = i + 1;
    const pos = ds.length === 1 ? 'only' : i === 0 ? 'left' : i === ds.length - 1 ? 'right' : 'middle';
    d.position = pos;
    d.name = `${d.internal ? 'laptop' : (d.label || 'display')} (${pos})`;
  });
  return ds;
}

// Which display does Fred mean? 1-based number, "left"/"right"/"middle",
// "laptop"/"main", or a display id. Unknown → null.
function pickDisplay(displays, which) {
  if (which == null || which === '') return null;
  const s = String(which).trim().toLowerCase();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return displays.find((d) => d.index === n) || displays.find((d) => d.id === n) || null;
  }
  if (/laptop|macbook|built.?in|ingebouwd|internal/.test(s)) return displays.find((d) => d.internal) || null;
  if (/main|primary|hoofd/.test(s)) return displays.find((d) => d.bounds.x === 0 && d.bounds.y === 0) || displays[0] || null;
  if (/left|links|gauche|izquierd/.test(s)) return displays[0] || null;
  if (/right|rechts|droit|derech/.test(s)) return displays[displays.length - 1] || null;
  if (/middle|center|centre|midden/.test(s)) return displays[Math.floor(displays.length / 2)] || null;
  return displays.find((d) => d.label && d.label.toLowerCase().includes(s)) || null;
}

function contains(d, p) {
  const b = d.bounds;
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}
function displayAt(displays, p) { return displays.find((d) => contains(d, p)) || null; }

// A screenshot of display d, `shot` = { width, height } of the image Claude saw.
// Image pixel (px, py) → global point.
function imageToGlobal(d, shot, px, py) {
  const b = d.bounds;
  const sx = b.width / shot.width, sy = b.height / shot.height;
  const x = b.x + Math.max(0, Math.min(shot.width - 1, Number(px))) * sx;
  const y = b.y + Math.max(0, Math.min(shot.height - 1, Number(py))) * sy;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}
function globalToImage(d, shot, p) {
  const b = d.bounds;
  return { x: Math.round(((p.x - b.x) * shot.width) / b.width), y: Math.round(((p.y - b.y) * shot.height) / b.height) };
}

// The image size we send for a display: at most maxW wide (keeps Claude's
// tokens sane and stays under the API's own downscale, so pixels stay exact).
function shotSize(d, maxW = 1440) {
  const w = Math.min(maxW, d.bounds.width);
  return { width: Math.round(w), height: Math.round((d.bounds.height * w) / d.bounds.width) };
}

// An OCR box (normalised 0..1, top-left origin) inside a captured region of
// global points → the box and its centre in global points.
function ocrBoxToGlobal(box, region) {
  const x = region.x + box.x * region.width, y = region.y + box.y * region.height;
  const w = box.w * region.width, h = box.h * region.height;
  return { x, y, width: w, height: h, center: { x: x + w / 2, y: y + h / 2 } };
}

// A rectangle (global points) around p, clipped to p's display — for "what is
// under / next to the cursor" checks.
function regionAround(displays, p, w = 360, h = 120) {
  const d = displayAt(displays, p);
  if (!d) return null;
  const b = d.bounds;
  const x = Math.max(b.x, Math.min(b.x + b.width - w, p.x - w / 2));
  const y = Math.max(b.y, Math.min(b.y + b.height - h, p.y - h / 2));
  return { x: Math.round(x), y: Math.round(y), width: Math.min(w, b.width), height: Math.min(h, b.height) };
}

module.exports = { normalizeDisplays, pickDisplay, displayAt, contains, imageToGlobal, globalToImage, shotSize, ocrBoxToGlobal, regionAround };
