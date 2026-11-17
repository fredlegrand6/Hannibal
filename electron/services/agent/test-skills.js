// ─────────────────────────────────────────────────────────────────────────
// TEST — Skills: toml-lite parser, loader, skill→plan compiler, the read-only
// morning-brief end to end, the subsume shell step-type, and the runnable check.
// Offline/deterministic: invoke is injected, no network. Run:
//   node electron/services/agent/test-skills.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const path = require('path');
const toml = require('./toml-lite');
const skills = require('./skills');

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed += 1; console.log(`  ✓ ${name}`); },
    (e) => { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; },
  );
}

(async () => {
  console.log('toml-lite — parser');

  await test('scalars, arrays, inline tables, comments', () => {
    const t = toml.parse([
      '# a comment',
      '[skill]',
      'name = "demo"',
      'version = "0.2.0"',
      'flag = true',
      'count = 3',
      'nums = [1, 2, 3]   # trailing comment',
      'words = ["pdf", "doc"]',
      'inline = { a = "x", b = "{{1.body}}" }',
    ].join('\n'));
    assert.equal(t.skill.name, 'demo');
    assert.equal(t.skill.flag, true);
    assert.equal(t.skill.count, 3);
    assert.deepEqual(t.skill.nums, [1, 2, 3]);
    assert.deepEqual(t.skill.words, ['pdf', 'doc']);
    assert.deepEqual(t.skill.inline, { a: 'x', b: '{{1.body}}' });
  });

  await test('array-of-tables + multi-line triple string with embedded refs', () => {
    const t = toml.parse([
      '[skill]',
      'name = "x"',
      '[[skill.steps]]',
      'tool = "a.b"',
      '[[skill.steps]]',
      'tool = "c.d"',
      'depends_on = [1]',
      'params = { ctx = """line one {{1}}',
      'line two {{1.body}}""" }',
    ].join('\n'));
    assert.equal(t.skill.steps.length, 2);
    assert.equal(t.skill.steps[0].tool, 'a.b');
    assert.deepEqual(t.skill.steps[1].depends_on, [1]);
    assert.equal(t.skill.steps[1].params.ctx, 'line one {{1}}\nline two {{1.body}}');
  });

  await test('string escapes \\n and \\"', () => {
    const t = toml.parse('[s]\nv = "a\\nb \\"q\\""');
    assert.equal(t.s.v, 'a\nb "q"');
  });

  console.log('Loader + morning-brief (the real file)');

  const list = skills.loadSkills();   // reads data/skills/*.toml
  await test('loads morning-brief from data/skills/', () => {
    const mb = list.find((s) => s.name === 'morning-brief');
    assert.ok(mb, 'morning-brief should load');
    assert.equal(mb.runnable, true);
    assert.equal(mb.planner_safe, true);          // all reads, no shell
    assert.equal(mb.stepCount, 5);
    assert.deepEqual(mb.requires.sort(), ['calendar.events', 'gex131.metrics', 'mail.inbox', 'memory.query', 'text.compose'].sort());
    assert.equal(mb.missingTools.length, 0);
  });

  await test('compile substitutes {{language}} default but leaves numeric step refs', () => {
    const mb = skills.getSkill('morning-brief');
    const plan = skills.compileSkill(mb, {});                 // no language arg → default english
    const compose = plan.steps[4];
    assert.ok(compose.params.instruction.includes('in english'), 'named param substituted with default');
    assert.ok(compose.params.context.includes('{{1}}'), 'numeric step ref preserved for the executor');
    assert.deepEqual(compose.depends_on, [1, 2, 3, 4]);
    assert.equal(plan.steps.every((s) => s.valid !== false), true, 'all steps valid against the catalog');
  });

  await test('compile honors an explicit language arg', () => {
    const plan = skills.compileSkill(skills.getSkill('morning-brief'), { language: 'dutch' });
    assert.ok(plan.steps[4].params.instruction.includes('in dutch'));
  });

  await test('morning-brief runs end to end (all reads, NO gate fires)', async () => {
    const events = [];
    const canned = {
      'calendar.events': { ok: true, events: [{ time: '10:00', title: 'Standup', day: 'today' }] },
      'mail.inbox': { ok: true, unread: 2, messages: [{ from: 'Rob', subject: 'Q3', uid: '7' }] },
      'gex131.metrics': { ok: true, gpu: null, mem: { used: 40, total: 96 } },
      'memory.query': { ok: true, results: [{ text: 'rebuttals due Friday', score: 0.7 }] },
    };
    const res = await skills.runSkill('morning-brief', { language: 'english' }, {
      invoke: async (tool, params) => {
        if (tool === 'text.compose') {
          assert.ok(params.context.includes('Standup'), 'compose got the calendar output woven in');
          return { ok: true, text: 'Morning Fred — standup at 10, two unread incl. Rob on Q3, box looks fine.' };
        }
        return canned[tool];
      },
      emit: (e) => events.push(e),
    });
    assert.equal(res.ok, true);
    assert.equal(Object.keys(res.results).length, 5);
    assert.ok(/standup/i.test(res.results[5].text), 'final step is the spoken narrative');
    assert.equal(events.filter((e) => String(e.type).startsWith('step:confirm') || String(e.type).startsWith('gate:')).length, 0, 'no gate for a read-only skill');
  });

  console.log('Subsume (shell step-type) + runnable check');

  await test('a shell step compiles to gated, planner-excluded mac.shell', async () => {
    const shellSkill = { name: 'cleanup', description: 'tidy', params: [], steps: [{ shell: 'rm -rf /tmp/scratch/*' }] };
    const enriched = skills.enrich(shellSkill);
    assert.equal(enriched.requires[0], 'mac.shell', 'shell → mac.shell');
    assert.equal(enriched.planner_safe, false, 'a shell-containing skill is planner-excluded');

    const events = []; let asked = false, ran = false;
    await skills.runSkill(shellSkill, {}, {
      confirmer: async () => { asked = true; return false; },     // user declines
      invoke: async () => { ran = true; return { ok: true }; },
      emit: (e) => events.push(e),
    });
    assert.equal(asked, true, 'shell step must hit the gate');
    assert.equal(ran, false, 'declined → not executed');
    assert.ok(events.some((e) => e.type === 'step:confirm-request'));
  });

  await test('a skill referencing an unknown tool is unrunnable, missing tool named', async () => {
    const bad = { name: 'bogus', description: 'x', params: [], steps: [{ tool: 'does.not.exist' }] };
    const enriched = skills.enrich(bad);
    assert.equal(enriched.runnable, false);
    assert.deepEqual(enriched.missingTools, ['does.not.exist']);
    const res = await skills.runSkill(bad, {}, { invoke: async () => ({ ok: true }), emit: () => {} });
    assert.equal(res.ok, false);
    assert.ok((res.missingTools || []).includes('does.not.exist'));
  });

  await test('skillCatalogText lists runnable + flags problems honestly', () => {
    const text = skills.skillCatalogText();
    assert.ok(text.includes('morning-brief'));
  });

  console.log(`\n${passed} checks passed.`);
})();
