// ─────────────────────────────────────────────────────────────────────────
// STEP 3 PROOF — does the confirmation GATE still fire on the BODY, across the
// wire, when the BRAIN (on GEX131) decides an action needs Fred's yes?
//
// This is a headless stand-in for the Mac body: it speaks no audio and opens no
// Mail window, but it registers the EXACT three down-handlers the real app will
// (body.confirm = the gate, body.invoke = the hands, emit = progress) and proves
// the control flow end-to-end over real Tailscale:
//
//   brain plans → hits a confirm:true write → RPCs body.confirm DOWN →
//   the BODY "speaks" the summary and returns Fred's decision → only on YES does
//   body.invoke run the action. On NO it's a clean skip. Nothing self-approves.
//
// Run (over Tailscale to the live brain):
//   BRAIN_URL=ws://gex131-1:8788 node proof-step3.js yes   # gate approved → acts
//   BRAIN_URL=ws://gex131-1:8788 node proof-step3.js no    # gate declined → skips
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const { BrainClient } = require('./client');

const decision = (process.argv[2] || 'yes').toLowerCase();
const sayYes = ['yes', 'y', 'go', 'ok', '1', 'true'].includes(decision);

const c = new BrainClient({ reconnect: false });
c.on('error', (e) => console.error('[body] error:', e.message));

// ── the three handlers the real Mac app will register ──

// body.confirm = THE GATE. In the real app this speaks via TTS and waits for a
// voice "yes". Here it just prints what would be spoken and returns the decision.
let gateFired = 0, actionsRun = 0;
c.setHandler('body.confirm', async ({ step, summary }) => {
  gateFired += 1;
  console.log(`\n  🔔 GATE (spoken on the Mac, in front of Fred):`);
  console.log(`     "${summary}"`);
  console.log(`     → Fred says: ${sayYes ? 'YES' : 'NO'}\n`);
  return sayYes; // boolean travels back UP to the brain as the gate decision
});

// body.invoke = THE HANDS. Runs the local action. Simulated here so we don't
// actually open Mail; logs prove it runs ONLY after a gate-yes.
c.setHandler('body.invoke', async ({ tool, params }) => {
  actionsRun += 1;
  console.log(`  🤚 HANDS (Mac executes): ${tool} ${JSON.stringify(params)}`);
  return { ok: true, simulated: true };
});

// emit = progress to the renderer (brain pulse + spoken progress).
c.setHandler('emit', async ({ event }) => {
  if (event && event.type) console.log(`     · ${event.type}${event.tool ? ' ' + event.tool : ''}`);
  return { ok: true };
});

(async () => {
  c.connect();
  try {
    const brain = await c.waitReady(8000);
    console.log(`[body] ✓ connected to brain on the box: ${brain.id} ${brain.version}`);
    console.log(`[body] asking the brain to run a confirm:true write (mail.send)…`);

    const steps = [{
      step: 1, tool: 'mail.send',
      params: { to: 'fredlegrand@revalisgroup.com', subject: 'Brain-on-GEX131 gate test',
                body: 'This send was DECIDED by the brain on GEX131 and CONFIRMED on the Mac.' },
      description: 'open a pre-filled email to Fred', critical: true, depends_on: [],
    }];

    const res = await c.request('agent.run', { goal: '[step3 proof] email myself', steps }, { timeout: 140000 });

    console.log(`\n[body] ── result ──`);
    console.log(`[body] gate fired on body: ${gateFired}×   actions executed on body: ${actionsRun}×`);
    console.log(`[body] brain record:`, JSON.stringify(res.record));
    const wrote = (res.record || []).some((r) => r.tool === 'mail.send' && r.executed);
    const skipped = (res.record || []).some((r) => r.tool === 'mail.send' && r.skipped);
    if (sayYes && gateFired === 1 && wrote && actionsRun === 1) console.log('[body] ✓ PASS: gate fired on the Mac, YES → action ran on the Mac.');
    else if (!sayYes && gateFired === 1 && skipped && actionsRun === 0) console.log('[body] ✓ PASS: gate fired on the Mac, NO → action SKIPPED, nothing sent.');
    else console.log('[body] ✗ UNEXPECTED — inspect the record above.');
    c.close(); process.exit(0);
  } catch (e) {
    console.error('[body] ✗ proof failed:', e.message);
    c.close(); process.exit(1);
  }
})();
