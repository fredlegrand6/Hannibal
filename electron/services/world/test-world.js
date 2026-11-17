// Headless test for World Awareness (Stage 2/3 multi-topic). No Electron needed.
//   node electron/services/world/test-world.js
// Live: routes + builds + narrates each topic against the self-host + Open-Meteo.
// Unit: number-invention guard, router fast-path + decline, weather (no key).
'use strict';

const fs = require('fs');
const path = require('path');
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '..', '..', '.env');
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch (_) {}
})();
process.env.WORLD_NARRATOR_POLISH = process.env.WORLD_NARRATOR_POLISH || '0'; // fast+deterministic for the matrix

const { runTopic } = require('./index');
const { route } = require('./router');
const { matchTopic } = require('./topics');
const { polishIsFaithful, buildLine } = require('./world-narrator');

let failures = 0;
function ok(c, m) { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failures++; }

async function main() {
  console.log('\n=== 1. ROUTER fast-path (spoken → topic key) ===');
  const cases = [
    ['what\'s happening with crypto', 'crypto'],
    ['how are the markets doing', 'markets'],
    ['what\'s going on in the middle east', 'regional:middle-east'],
    ['how are things in the gulf', 'regional:middle-east'],
    ['what\'s happening in europe', 'regional:europe'],
    ['energy update', 'energy'],
    ['what\'s the latest in the world', 'news'],
    ['how\'s the conflict situation', 'conflict'],
    ['the weather', 'weather'],
  ];
  for (const [spoken, want] of cases) {
    const tp = matchTopic(spoken);
    ok(tp && tp.key === want, `"${spoken}" → ${tp ? tp.key : 'null'} (want ${want})`);
  }
  console.log('  -- graceful decline --');
  const decl = await route('what\'s happening with my goldfish', { useLlm: false });
  ok(decl === null, 'unknown topic (no-LLM) declines → null');

  console.log('\n=== 2. LIVE dual-dispatch per topic (EYES skipped) ===');
  const topics = ['crypto', 'markets', 'news', 'regional:middle-east', 'regional:europe', 'energy', 'government', 'conflict', 'flights', 'weather'];
  for (const key of topics) {
    let res;
    try { res = await runTopic(null, key, { open: false }); } catch (e) { res = { ok: false, error: e.message }; }
    const tag = res.ok ? (res.degraded ? 'OK*deg' : 'OK') : 'FAIL';
    console.log(`  [${tag}] ${key.padEnd(22)} → ${JSON.stringify(res.narration || res.error)}`);
    ok(res.ok && typeof res.narration === 'string' && res.narration.length > 0, `${key}: produced a spoken line`);
    ok(!res.narration || (!/\n/.test(res.narration) && res.narration.length < 400), `${key}: one-line, sane length`);
  }

  console.log('\n=== 3. DECLINE via runTopic (untracked) ===');
  const d = await runTopic(null, 'zzz-not-a-topic', { open: false });
  ok(d.ok && d.declined === true, `untracked → declined ("${d.narration}")`);

  console.log('\n=== 4. NUMBER-INVENTION GUARD ===');
  const base = 'Crypto\'s quiet — BTC around $62.8k, ETH around $1,668.';
  ok(polishIsFaithful(base, 'BTC near $62.8k, ETH about $1,668 — calm.') === true, 'faithful rephrase accepted');
  ok(polishIsFaithful(base, 'BTC at $63k, ETH $1,700.') === false, 'invented figures rejected');

  console.log('\n=== 5. WEATHER (Open-Meteo, no key) real values ===');
  const w = await runTopic(null, 'weather', { open: false });
  ok(w.ok && /Naarden|Ibiza/.test(w.narration || ''), `weather names a base: "${w.narration}"`);

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('TEST CRASHED:', e); process.exit(1); });
