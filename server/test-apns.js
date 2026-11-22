// TEST — push to the iPhone (APNs): token signing, token list, bad tokens dropped.
// Offline (fake Apple). Run: node server/test-apns.js
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPush, makeJwt } = require('./apns');

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed += 1; console.log(`  ✓ ${name}`); })
    .catch((e) => { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; });
}
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const keyB64 = Buffer.from(keyPem).toString('base64');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apns-'));
const T1 = 'ab'.repeat(32);
const T2 = 'cd'.repeat(32);

(async () => {
  console.log('push (APNs)');

  await test('the Apple token is a valid ES256 JWT with key id and team', () => {
    const jwt = makeJwt({ keyPem, keyId: 'KEY1234567', teamId: 'X4GXK2YQW8', now: 1700000000000 });
    const [h, c, sig] = jwt.split('.');
    const dec = (x) => JSON.parse(Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    assert.deepStrictEqual(dec(h), { alg: 'ES256', kid: 'KEY1234567' });
    assert.deepStrictEqual(dec(c), { iss: 'X4GXK2YQW8', iat: 1700000000 });
    const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    assert.ok(ok);
  });

  await test('not configured = nothing sent, and says so', async () => {
    const p = createPush({ log: () => {}, sendImpl: async () => { throw new Error('must not send'); } });
    assert.strictEqual(p.configured, false);
    p.register(T1, 'sandbox');
    assert.strictEqual(await p.notify({ body: 'hi' }), 0);
  });

  const sent = [];
  let answer = () => ({ status: 200 });
  const file = path.join(dir, 'tokens.json');
  const p = createPush({ keyB64, keyId: 'KEY1234567', teamId: 'X4GXK2YQW8', filePath: file, log: () => {},
    sendImpl: async (req) => { sent.push(req); return answer(req); } });

  await test('tokens are checked, kept on disk, newest first, no duplicates', () => {
    assert.strictEqual(p.register('xyz'), false);
    assert.ok(p.register(T1, 'sandbox'));
    assert.ok(p.register(T2.toUpperCase(), 'production'));
    assert.ok(p.register(T1, 'sandbox'));
    assert.deepStrictEqual(p._tokens().map((t) => [t.token, t.env]), [[T1, 'sandbox'], [T2, 'production']]);
    const again = createPush({ keyB64, keyId: 'K', teamId: 'T', filePath: file, log: () => {} });
    assert.strictEqual(again.count(), 2);
  });

  await test('a push goes to the right Apple server with the right headers and payload', async () => {
    sent.length = 0;
    const n = await p.notify({ body: 'Shall I trash it?', category: 'CONFIRM', data: { confirmId: 'abc' } });
    assert.strictEqual(n, 2);
    const s1 = sent.find((r) => r.path.endsWith(T1));
    assert.strictEqual(s1.host, 'api.sandbox.push.apple.com');
    assert.strictEqual(sent.find((r) => r.path.endsWith(T2)).host, 'api.push.apple.com');
    assert.strictEqual(s1.headers['apns-topic'], 'com.revalisgroup.hannibal');
    assert.strictEqual(s1.headers['apns-push-type'], 'alert');
    assert.match(s1.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const body = JSON.parse(s1.body);
    assert.deepStrictEqual(body.aps.alert, { title: 'Hannibal', body: 'Shall I trash it?' });
    assert.strictEqual(body.aps.category, 'CONFIRM');
    assert.strictEqual(body.confirmId, 'abc');
  });

  await test('a dead token (app deleted) is dropped, a working one kept', async () => {
    answer = (req) => (req.path.endsWith(T2) ? { status: 410, body: '{"reason":"Unregistered"}' } : { status: 200 });
    assert.strictEqual(await p.notify({ body: 'x' }), 1);
    assert.deepStrictEqual(p._tokens().map((t) => t.token), [T1]);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
