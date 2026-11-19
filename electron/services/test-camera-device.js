// TEST — camera picked by name. Run: node electron/services/test-camera-device.js
'use strict';
const assert = require('assert');
const { parseVideoDevices, pickCamera, createCameraPicker } = require('./camera-device');

const LIST = `[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] Camera MacBook Pro
[AVFoundation indev @ 0x1] [1] OBSBOT Tiny 3 StreamCamera
[AVFoundation indev @ 0x1] [2] Camera FREDERIC’s iPhone
[AVFoundation indev @ 0x1] [5] Capture screen 0
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] MacBook Pro microfoon
[AVFoundation indev @ 0x1] [2] OBSBOT Tiny 3 Microphone`;
// osascript output arrives without newlines — must still parse.
const FLAT = LIST.replace(/\n/g, '');

let n = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(() => { n++; console.log(`  ✓ ${name}`); },
  (e) => { console.error(`  ✗ ${name}\n${e.stack}`); process.exitCode = 1; });

(async () => {
  await t('parses video devices only', () => {
    const d = parseVideoDevices(LIST);
    assert.deepStrictEqual(d.map((x) => x.index), [0, 1, 2, 5]);
    assert.strictEqual(d[1].name, 'OBSBOT Tiny 3 StreamCamera');
    assert.deepStrictEqual(parseVideoDevices(FLAT), d);
  });
  await t('prefers the OBSBOT by name', () => assert.strictEqual(pickCamera(parseVideoDevices(LIST)), 'OBSBOT Tiny 3 StreamCamera'));
  await t('a number is used as is', () => assert.strictEqual(pickCamera(parseVideoDevices(LIST), { want: '2' }), '2'));
  await t('falls back to the index when nothing matches', () => {
    assert.strictEqual(pickCamera([{ index: 0, name: 'Camera MacBook Pro' }], { fallbackIndex: '0' }), '0');
    assert.strictEqual(pickCamera([], { want: 'OBSBOT', fallbackIndex: '3' }), '3');
  });
  await t('picker caches and re-checks on demand', async () => {
    let calls = 0;
    const p = createCameraPicker({ list: async () => { calls++; return parseVideoDevices(LIST); }, log: () => {} });
    assert.strictEqual(await p.resolve(), 'OBSBOT Tiny 3 StreamCamera');
    await p.resolve();
    assert.strictEqual(calls, 1);
    await p.resolve({ fresh: true });
    assert.strictEqual(calls, 2);
  });
  console.log(`\n${n} passed`);
})();
