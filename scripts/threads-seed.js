#!/usr/bin/env node
// Build data/threads.json from the diary, once (or again, to add what's missing).
//
//   node scripts/threads-seed.js [housekeeping.json]
//
// Reads the recent conversations in data/conversations.json, lets Claude turn
// their open items into threads with a status (by meaning, merging duplicates),
// with the optional housekeeping file: a JSON list of things Fred says now
// ("the reminders are fixed and tested", "forget the passwords"), which win
// over the diary. Claude matches them to the threads by meaning.
// Run it with Hannibal stopped (the app keeps threads.json in memory).
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch (_) {}

const DATA = path.join(ROOT, 'data');
const { createThreadStore } = require('../electron/services/threads');
const { createQdrantMemory } = require('../electron/services/qdrant-memory');
const brain = require('../electron/services/claude-brain');

(async () => {
  const memory = createQdrantMemory({ qdrantUrl: process.env.QDRANT_URL || '', ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434', log: () => {} });
  const store = createThreadStore({ filePath: path.join(DATA, 'threads.json'), embed: (t) => memory.embed(t) });
  let episodes = [];
  try { episodes = JSON.parse(fs.readFileSync(path.join(DATA, 'conversations.json'), 'utf8')).episodes || []; } catch (_) {}
  const recent = episodes.slice(-14);
  console.log(`${recent.length} recent conversations, ${store.size} threads already`);
  const hk = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : [];
  if (recent.length || hk.length) {
    const transcript = recent.map((e) => `[${String(e.start).slice(0, 16)}] ${e.title}. ${e.summary}${(e.open || []).length ? `\nLeft open: ${e.open.join('; ')}` : ''}`).join('\n\n');
    const now = hk.length ? `\n\nFRED SAYS NOW (${new Date().toISOString().slice(0, 10)}; his word wins over everything above):\n${hk.map((x) => `- ${x}`).join('\n')}` : '';
    const r = await store.reconcile({
      transcript: `(Summaries of recent conversations, oldest first. Later ones can close what earlier ones left open.)\n\n${transcript}${now}`,
      summarize: (t, p) => brain.summarizeForJournal(t, p),
    });
    console.log(r.ok ? `from the diary: ${r.updated.length} threads` : `diary pass failed: ${r.error}`);
  }
  for (const t of store.all()) console.log(`  ${t.status.padEnd(11)} ${t.title}`);
  process.exit(0);
})();
