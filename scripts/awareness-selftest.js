// Headless verification of Stage 7's CHEAP layers — the parts that must be right
// before the loop ever calls the vision model. Proves:
//   1. Perceptual hash: two captures of a STATIC screen → tiny Hamming (skip, no OCR).
//      A genuinely different frame → Hamming well above threshold (proceed to OCR).
//   2. StruggleDetector math: a "stuck on the same error" sequence crosses 0.5.
//   3. Brakes: grace (no fire until sustained), cooldown (no re-fire), app-switch reset.
//
//   run:  node scripts/awareness-selftest.js
//
// The vision model fires ONLY inside `if (d.fire)` in awareness.js runCycle — so
// proving the detector's fire logic here proves the model stays idle otherwise.

const { spawnSync } = require('child_process');
const fs = require('fs');
const {
  StruggleDetector, aHashFromBmp, hamming, djb2, classifyApp, CONFIG,
} = require('../electron/services/awareness');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } };

function sips(args) { spawnSync('/usr/bin/sips', args, { stdio: 'ignore' }); }
function bmpHash(png) {
  const bmp = `/tmp/aware-st-${djb2(png)}.bmp`;
  sips(['-s', 'format', 'bmp', '-z', '8', '8', png, '--out', bmp]);
  const h = aHashFromBmp(bmp);
  fs.unlinkSync(bmp);
  return h;
}

console.log('\n── 1. CAPTURE GATE — perceptual hash ──');
{
  const a = '/tmp/aware-st-a.png', b = '/tmp/aware-st-b.png', flip = '/tmp/aware-st-flip.png';
  spawnSync('/usr/sbin/screencapture', ['-x', '-D', '1', a], { stdio: 'ignore' });
  spawnSync('/usr/sbin/screencapture', ['-x', '-D', '1', b], { stdio: 'ignore' });
  const ha = bmpHash(a), hb = bmpHash(b);
  const staticDist = hamming(ha, hb);
  ok(staticDist <= CONFIG.changeHammingThreshold,
    `static screen: consecutive frames Hamming=${staticDist} ≤ threshold ${CONFIG.changeHammingThreshold} → SKIP (no OCR/LLM)`);

  // A genuinely different frame: synthesize two 8×8 24-bit BMPs with different
  // spatial patterns (left/right split vs top/bottom split). This also exercises
  // the BMP parser directly and proves the hash discriminates content layout.
  const mkBmp = (file, bright) => {
    const W = 8, H = 8, row = W * 3, data = row * H, buf = Buffer.alloc(54 + data, 0);
    buf.write('BM'); buf.writeUInt32LE(54 + data, 2); buf.writeUInt32LE(54, 10);
    buf.writeUInt32LE(40, 14); buf.writeInt32LE(W, 18); buf.writeInt32LE(H, 22);
    buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = bright(x, y) ? 255 : 0, o = 54 + y * row + x * 3;
      buf[o] = v; buf[o + 1] = v; buf[o + 2] = v;
    }
    fs.writeFileSync(file, buf);
  };
  const p1 = '/tmp/aware-st-p1.bmp', p2 = '/tmp/aware-st-p2.bmp';
  mkBmp(p1, (x) => x < 4);  // left half bright
  mkBmp(p2, (_x, y) => y < 4); // top half bright
  const changeDist = hamming(aHashFromBmp(p1), aHashFromBmp(p2));
  ok(changeDist > CONFIG.changeHammingThreshold,
    `changed frame: distinct layouts Hamming=${changeDist} > threshold → PROCEED to OCR`);
  [a, b, flip, p1, p2].forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
}

console.log('\n── 2. STRUGGLE MATH — stuck on the same error ──');
{
  // 600-char constant error footer (the "stuck output"), with a tiny tweak in the
  // header each cycle: lots of unique states (trial-and-error), minuscule real
  // movement (low progress), the same bottom output (repeated output).
  const ERR = 'TypeError: cannot read property foo of undefined\n  at handler (app.js:42)\n'.repeat(12);
  const det = new StruggleDetector({ ...CONFIG });
  const base = 1_000_000_000_000;
  let lastAnalysis = null;
  for (let i = 0; i < 12; i++) {
    const text = `function attempt${i}() { let x = ${i}; return x + ${i % 3}; }\n` + ERR;
    det.push({ ts: base + i * 10000, app: 'Code', appClass: 'code_editor', ocr: text, ocrHash: djb2(text), bottomHash: djb2(text.slice(-CONFIG.bottomChars)) }, base + i * 10000);
    lastAnalysis = det.analyze(base + i * 10000);
  }
  console.log(`  signals: ${JSON.stringify(lastAnalysis.signals, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v)}`);
  ok(lastAnalysis.score >= CONFIG.struggleThreshold,
    `composite=${lastAnalysis.score.toFixed(2)} ≥ ${CONFIG.struggleThreshold} → struggling`);
  ok(lastAnalysis.signals.repeatedOutput > 0.5, `repeated-output signal high (${lastAnalysis.signals.repeatedOutput.toFixed(2)})`);
}

console.log('\n── 3. BRAKES — grace, cooldown, app reset ──');
{
  const det = new StruggleDetector({ ...CONFIG });
  const ERR = 'Error: build failed\n'.repeat(40);
  const base = 2_000_000_000_000;
  let firstFireAt = null, fireCount = 0, crossAt = null;
  for (let i = 0; i < 60; i++) {       // 60 snapshots × 10s = 10 min
    const now = base + i * 10000;
    const text = `attempt ${i} ${'x'.repeat(i % 7)}\n` + ERR;
    det.push({ ts: now, app: 'Code', appClass: 'code_editor', ocr: text, ocrHash: djb2(text), bottomHash: djb2(text.slice(-CONFIG.bottomChars)) }, now);
    const d = det.analyze(now);
    if (d.over && crossAt === null) crossAt = now;
    if (d.fire) { fireCount++; if (firstFireAt === null) firstFireAt = now; }
  }
  ok(crossAt !== null, 'composite crossed threshold during the run');
  ok(firstFireAt !== null, 'detector fired at least once');
  if (firstFireAt && crossAt) {
    const waited = firstFireAt - crossAt;
    ok(waited >= CONFIG.graceMs, `grace honored: waited ${Math.round(waited / 1000)}s ≥ ${CONFIG.graceMs / 1000}s before firing`);
  }
  ok(fireCount <= 4, `cooldown honored: only ${fireCount} fire(s) across 10 min (no nagging)`);

  // app-switch reset: a fresh app empties the window.
  const det2 = new StruggleDetector({ ...CONFIG });
  const t0 = 3_000_000_000_000;
  for (let i = 0; i < 8; i++) det2.push({ ts: t0 + i * 1000, app: 'Code', appClass: 'code_editor', ocr: `a${i}`, ocrHash: djb2(`a${i}`), bottomHash: '' }, t0 + i * 1000);
  const before = det2.window.length;
  det2.push({ ts: t0 + 9000, app: 'Safari', appClass: 'browser', ocr: 'new', ocrHash: djb2('new'), bottomHash: '' }, t0 + 9000);
  ok(before === 8 && det2.window.length === 1, `app switch reset the window (${before} → ${det2.window.length})`);
}

console.log('\n── 4. APP CLASSIFICATION ──');
{
  ok(classifyApp('Code', 'main.js — hannibal') === 'code_editor', 'VS Code → code_editor');
  ok(classifyApp('iTerm2', 'fred@mac') === 'terminal', 'iTerm → terminal');
  ok(classifyApp('Safari', 'GitHub') === 'browser', 'Safari → browser');
  ok(classifyApp('Figma', 'Untitled') === 'creative_app', 'Figma → creative_app');
  ok(classifyApp('Notes', '') === 'general', 'Notes → general');
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
