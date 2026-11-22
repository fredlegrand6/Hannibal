// node src/test-voice-player.js
// Hannibal's voice must never go quiet until a restart: failed voice requests,
// clips that never end, a stuck audio output, speakers changing, and "stop".
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const VP = require('./voice-player');
const { createVoiceDropLog } = require('../electron/services/voice-drops');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('✓', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake Web Audio context. clock: currentTime moves while "running".
// neverEnds: clips start but "ended" never comes (what happened on 22 Nov).
let made = 0;
function fakeCtx({ state = 'running', resumeHangs = false, neverEnds = false, clipMs = 30 } = {}) {
  const ctx = {
    id: ++made, state, destination: {}, started: 0, t0: Date.now(), frozenAt: 0,
    get currentTime() { return this.state === 'running' ? (Date.now() - this.t0) / 1000 : this.frozenAt; },
    resume() { if (resumeHangs) return new Promise(() => {}); this.state = 'running'; return Promise.resolve(); },
    close() { this.state = 'closed'; return Promise.resolve(); },
    decodeAudioData() { return this.state === 'closed' ? Promise.reject(new Error('closed')) : Promise.resolve({ duration: clipMs / 1000 }); },
    createBufferSource() {
      const src = {
        connect() {}, disconnect() {}, stopped: false,
        start() { ctx.started++; if (!neverEnds && ctx.state === 'running') setTimeout(() => { if (!src.stopped && src.onended) src.onended(); }, clipMs); },
        stop() { src.stopped = true; },
      };
      return src;
    },
  };
  return ctx;
}
function fakeDevices(label = 'MacBook Pro Speakers') {
  const ls = [];
  return {
    label,
    addEventListener: (ev, f) => { if (ev === 'devicechange') ls.push(f); },
    enumerateDevices: async function () { return [{ kind: 'audiooutput', deviceId: 'default', label: `Default - ${this.label}` }]; },
    fire() { ls.forEach((f) => f()); },
  };
}

// The renderer's wiring, with fakes: same calls voice-controller.js makes.
function rig({ contexts, tts, mediaDevices = fakeDevices(), playVio = null, useVio } = {}) {
  const drops = [];
  const queue = contexts.slice();
  const out = VP.createAudioOut({ makeContext: () => queue.shift() || fakeCtx(), mediaDevices, resumeMs: 60 });
  const speaker = VP.createSpeaker({
    tts: tts || (async (text) => new Uint8Array([1, 2, 3, text.length])),
    decode: (ab) => out.current().decodeAudioData(ab),
    playVio, useVio,
    playPage: async (buf) => VP.playBuffer(await out.ensure(), buf, { startMs: 80, tickMs: 10, limitMs: 200 }),
    recover: async (why) => { out.rebuild(why); await out.ensure(); },
    onDrop: (d) => drops.push({ ...d, device: out.device() }),
    ttsMs: 150, decodeMs: 100,
  });
  return { out, speaker, drops };
}

(async () => {
  await t('clip time limit is its length plus a margin, with a hard cap', () => {
    assert.strictEqual(VP.clipLimitMs(4000), 6500);
    assert.strictEqual(VP.clipLimitMs(20000), 25000);
    assert.strictEqual(VP.clipLimitMs(0), 30000);
    assert.strictEqual(VP.clipLimitMs(10 * 60000), VP.HARD_CAP_MS);
  });

  await t('a normal sentence plays with no dropout', async () => {
    const r = rig({ contexts: [fakeCtx()] });
    const res = await r.speaker.speak('Good morning Fred.');
    assert.deepStrictEqual(res, { ok: true, path: 'page' });
    assert.strictEqual(r.drops.length, 0);
  });

  await t('failed TTS request: logged at stage "tts", retried once, then skipped; next sentence still plays', async () => {
    let calls = 0;
    const r = rig({ contexts: [fakeCtx()], tts: async (text) => { calls++; if (/broken/.test(text)) throw new Error('ElevenLabs 503'); return new Uint8Array([1, 2]); } });
    const items = [{ text: 'this one is broken' }, { text: 'this one works' }];
    const res = await VP.runQueue({ next: () => items.shift(), more: () => false, speak: (it) => r.speaker.speak(it.text) });
    assert.deepStrictEqual(res, { played: 1, dropped: 1 });
    assert.strictEqual(calls, 3, 'broken sentence asked twice, good one once');
    assert.strictEqual(r.drops.length, 1);
    assert.strictEqual(r.drops[0].stage, 'tts');
    assert.match(r.drops[0].error, /ElevenLabs 503/);
    assert.strictEqual(r.drops[0].recovered, false);
  });

  await t('a voice request that hangs is cut off by its time limit', async () => {
    const r = rig({ contexts: [fakeCtx()], tts: () => new Promise(() => {}) });
    const t0 = Date.now();
    const res = await r.speaker.speak('never comes back');
    assert.deepStrictEqual(res, { dropped: 'tts' });
    assert.ok(Date.now() - t0 < 1000, 'gave up quickly, did not wait forever');
    assert.match(r.drops[0].error, /longer than 150 ms/);
  });

  await t('clip that never fires "ended": cut off, output rebuilt, retried once, and it plays', async () => {
    const stuck = fakeCtx({ neverEnds: true });
    const r = rig({ contexts: [stuck, fakeCtx()] });
    const res = await r.speaker.speak('Your meeting with HTS is at three.');
    assert.deepStrictEqual(res, { ok: true, path: 'page' });
    assert.strictEqual(stuck.state, 'closed', 'the stuck output was thrown away');
    assert.strictEqual(r.drops.length, 1);
    assert.strictEqual(r.drops[0].stage, 'play');
    assert.match(r.drops[0].error, /never finished/);
    assert.strictEqual(r.drops[0].recovered, true);
  });

  await t('a clip that never ends twice is skipped and does not block the queue', async () => {
    const r = rig({ contexts: [fakeCtx({ neverEnds: true }), fakeCtx({ neverEnds: true }), fakeCtx()] });
    const items = [{ text: 'stuck' }, { text: 'after the stuck one' }];
    const res = await VP.runQueue({ next: () => items.shift(), more: () => false, speak: (it) => r.speaker.speak(it.text) });
    assert.deepStrictEqual(res, { played: 1, dropped: 1 });
    assert.strictEqual(r.drops.length, 1);
    assert.strictEqual(r.drops[0].recovered, false);
  });

  await t('suspended AudioContext whose resume() hangs: rebuilt before playing, no restart needed', async () => {
    const asleep = fakeCtx({ state: 'suspended', resumeHangs: true });
    const r = rig({ contexts: [asleep, fakeCtx()] });
    const res = await r.speaker.speak('Welcome back.');
    assert.deepStrictEqual(res, { ok: true, path: 'page' });
    assert.strictEqual(asleep.state, 'closed');
    assert.strictEqual(asleep.started, 0, 'nothing was played into the dead output');
    assert.strictEqual(r.drops.length, 0, 'fixed before the sentence, so nothing dropped');
  });

  await t('suspended output that claims to run but makes no sound: start watchdog catches it, retry plays', async () => {
    const mute = fakeCtx();
    Object.defineProperty(mute, 'currentTime', { get: () => 0 });   // clock never moves
    mute.createBufferSource = () => ({ connect() {}, disconnect() {}, start() {}, stop() {} });
    const r = rig({ contexts: [mute, fakeCtx()] });
    const res = await r.speaker.speak('Can you hear me?');
    assert.deepStrictEqual(res, { ok: true, path: 'page' });
    assert.match(r.drops[0].error, /no sound started/);
    assert.strictEqual(r.drops[0].recovered, true);
  });

  await t('speakers change (devicechange): next sentence gets a fresh output on the new speakers', async () => {
    const dev = fakeDevices('MacBook Pro Speakers');
    const first = fakeCtx();
    const r = rig({ contexts: [first, fakeCtx()], mediaDevices: dev });
    await r.speaker.speak('one');
    assert.strictEqual(r.out.builds, 1);
    dev.label = 'USB-C Audio'; dev.fire();
    await sleep(10);
    assert.strictEqual(r.out.device(), 'USB-C Audio');
    await r.speaker.speak('two');
    assert.strictEqual(r.out.builds, 2, 'rebuilt once after the change');
    assert.strictEqual(first.state, 'closed');
  });

  await t('speakers vanish mid-clip: the clip is caught, logged with the new device, and replayed', async () => {
    const dev = fakeDevices('PHL 27E1N');
    const dying = fakeCtx({ neverEnds: true });
    const r = rig({ contexts: [dying, fakeCtx()], mediaDevices: dev });
    await sleep(5);
    const p = r.speaker.speak('the monitor goes to sleep now');
    await sleep(20);
    dying.state = 'suspended'; dying.frozenAt = 0.02;
    dev.label = 'MacBook Pro Speakers'; dev.fire();
    const res = await p;
    assert.deepStrictEqual(res, { ok: true, path: 'page' });
    assert.strictEqual(r.drops[0].device, 'MacBook Pro Speakers');
    assert.strictEqual(r.drops[0].recovered, true);
  });

  await t('"Hannibal stop" mid-clip cuts at once, even on a dead output, and nothing after it plays', async () => {
    const r = rig({ contexts: [fakeCtx({ neverEnds: true })] });
    let seq = 1;
    const items = [{ text: 'a long answer' }, { text: 'more of it' }];
    const spoken = [];
    const q = VP.runQueue({ next: () => items.shift(), more: () => false, isCurrent: () => seq === 1,
      speak: (it) => { spoken.push(it.text); return r.speaker.speak(it.text, { isCurrent: () => seq === 1 }); } });
    await sleep(30);
    const t0 = Date.now();
    seq++; r.speaker.stop();
    await q;
    assert.ok(Date.now() - t0 < 50, 'stopped within 50 ms');
    assert.deepStrictEqual(spoken, ['a long answer']);
    assert.strictEqual(r.drops.length, 0, 'a stop is not a dropout');
    assert.strictEqual(r.speaker.playing, false);
  });

  await t('voice helper: a device change gets one more go there, a hang falls back to the page', async () => {
    let calls = 0;
    const r1 = rig({ contexts: [fakeCtx()], useVio: () => true,
      playVio: async () => (++calls === 1 ? { ok: false, error: 'audio device changed', retryable: true } : { ok: true }) });
    assert.deepStrictEqual(await r1.speaker.speak('x'), { ok: true, path: 'helper' });
    assert.strictEqual(calls, 2);
    const r2 = rig({ contexts: [fakeCtx()], useVio: () => true, playVio: async () => ({ ok: false, error: 'no sound started within 4000 ms' }) });
    assert.deepStrictEqual(await r2.speaker.speak('y'), { ok: true, path: 'page' });
    assert.strictEqual(r2.drops[0].path, 'helper');
    assert.strictEqual(r2.drops[0].recovered, true);
  });

  await t('queue: a sentence stuck past its cap is abandoned (stage "queue") and the rest plays', async () => {
    const items = [{ text: 'hangs' }, { text: 'fine' }];
    const drops = []; let abandoned = 0;
    const res = await VP.runQueue({ next: () => items.shift(), more: () => false, itemCapMs: 60,
      speak: (it) => (it.text === 'hangs' ? new Promise(() => {}) : Promise.resolve({ ok: true })),
      onDrop: (d) => drops.push(d), onAbandon: () => abandoned++ });
    assert.deepStrictEqual(res, { played: 1, dropped: 1 });
    assert.strictEqual(drops[0].stage, 'queue'); assert.strictEqual(abandoned, 1);
  });

  await t('queue: never waits forever for the rest of a reply', async () => {
    const drops = [];
    const res = await VP.runQueue({ next: () => undefined, more: () => true, idleCapMs: 50, pollMs: 5, speak: async () => ({ ok: true }), onDrop: (d) => drops.push(d) });
    assert.deepStrictEqual(res, { played: 0, dropped: 0 });
    assert.strictEqual(drops[0].stage, 'queue');
  });

  await t('dropout log: written with time, stage, error and speakers; "today" answers in plain words', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vdrop-')), 'voice-dropouts.log');
    const log = createVoiceDropLog({ file, log: () => {} });
    assert.strictEqual(log.list().summary, 'No voice dropouts today.');
    log.record({ stage: 'play', error: 'clip never finished', device: 'PHL 27E1N', recovered: true, text: 'Your meeting is at three.' });
    log.record({ stage: 'tts', error: 'ElevenLabs 503', device: 'MacBook Pro Speakers', recovered: false, where: 'phone' });
    log.record({ stage: 'bogus', error: 'x' });
    const r = log.list();
    assert.strictEqual(r.count, 3);
    assert.deepStrictEqual(r.by_stage, { play: 2, tts: 1 });
    assert.strictEqual(r.dropouts[0].device, 'PHL 27E1N');
    assert.ok(r.dropouts[0].t && !Number.isNaN(Date.parse(r.dropouts[0].t)));
    assert.match(r.summary, /^3 voice dropouts today .*1 fixed themselves, 2 sentences were skipped\.$/);
    assert.strictEqual(r.dropouts[1].where, 'phone');
    assert.strictEqual(log.list(1).count, 3);
  });

  await t('the voice.dropouts tool is in the catalog for Claude', () => {
    const catalog = require('../electron/services/agent/catalog');
    const tool = catalog.getTool('voice.dropouts');
    assert.ok(tool && tool.via.channel === 'voice:dropouts');
  });

  console.log(`\n${n} voice playback tests passed`);
})().catch((e) => { console.error('✗', e); process.exit(1); });
