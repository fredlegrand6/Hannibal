// TEST — photo memory: remember with place + photo, find it again, forget it.
// Run: node server/test-spots.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSpots, ago } = require('./spots');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}

(async () => {
  console.log('spots');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spots-'));
  let t = Date.parse('2026-11-23T10:00:00Z');
  const kept = [];
  const mk = (over = {}) => createSpots({
    filePath: path.join(dir, 'spots.json'), photoDir: path.join(dir, 'spots'),
    here: async () => ({ ok: true, lat: 38.9089, lon: 1.4328, accuracy: 12, address: 'Avinguda d\'Espanya 5, Eivissa' }),
    lastPhoto: () => ({ b64: Buffer.from('jpeg!').toString('base64'), at: t - 60e3 }),
    remember: async (x) => kept.push(x), now: () => t, ...over,
  });

  await test('"remember where I parked": place + photo kept', async () => {
    const s = mk();
    const r = await s.add('where I parked', 'Level -2, spot B14, next to the lift', true);
    assert.ok(r.ok && r.photo);
    assert.strictEqual(r.destination, '38.9089,1.4328');
    assert.match(r.place, /Eivissa/);
    assert.strictEqual(s.photo(r.id).toString(), 'jpeg!');
    assert.match(kept[0], /where I parked: Level -2/);
  });

  await test('"where did I park?" finds it later, with how long ago (and survives a restart)', async () => {
    t += 3 * 3600e3;
    const s = mk();
    await s.add('the wine Château Musar 2017', 'red, Lebanon, bought at the bodega', false);
    const r = s.find('where did I park my car');
    assert.strictEqual(r.spots[0].label, 'where I parked');
    assert.strictEqual(r.spots[0].when, '3 h ago');
    assert.strictEqual(s.find('musar').spots[0].photo, false, 'with_photo false keeps no photo');
    assert.strictEqual(s.find('').spots[0].label, 'the wine Château Musar 2017', 'empty = latest');
  });

  await test('an old photo is not attached; no location still keeps the note', async () => {
    const s = mk({ here: async () => null, lastPhoto: () => ({ b64: 'eA==', at: t - 3600e3 }) });
    const r = await s.add('this restaurant', 'Can Pujol', true);
    assert.ok(r.ok && !r.photo && !r.destination);
    assert.match(r.note2, /could not get the location/);
  });

  await test('forget', () => {
    const s = mk();
    assert.strictEqual(s.forget('parked').ok, true);
    assert.strictEqual(s.find('parked').spots.length, 0);
    assert.strictEqual(s.forget('nothing here').ok, false);
    assert.strictEqual(ago(30 * 60e3), '30 min ago');
  });

  console.log(process.exitCode ? 'some FAILED' : `${passed} passed`);
})();
