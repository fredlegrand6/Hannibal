#!/usr/bin/env node
// Build data/threads.json from the diary, once (or again, to add what's missing).
//
//   node scripts/threads-seed.js [housekeeping.json]
//
// Reads the recent conversations in data/conversations.json, lets Claude turn
// their open items into threads with a status (by meaning, merging duplicates),
// then applies the optional housekeeping file: a JSON list of
// { "thread": "words or id", "status": "done|dropped|...", "note": "..." }.
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
  if (recent.length) {
    const transcript = recent.map((e) => `[${String(e.start).slice(0, 16)}] ${e.title}. ${e.summary}${(e.open || []).length ? `\nLeft open: ${e.open.join('; ')}` : ''}`).join('\n\n');
    const r = await store.reconcile({
      transcript: `(Summaries of recent conversations, oldest first. Later ones can close what earlier ones left open.)\n\n${transcript}`,
      summarize: (t, p) => brain.summarizeForJournal(t, p),
    });
    console.log(r.ok ? `from the diary: ${r.updated.length} threads` : `diary pass failed: ${r.error}`);
  }
  const hk = process.argv[2];
  if (hk) {
    for (const u of JSON.parse(fs.readFileSync(hk, 'utf8'))) {
      const hit = await store.match(u.thread, { min: 0.62 });
      const r = await store.upsert({ id: hit ? hit.id : undefined, title: hit ? hit.title : u.thread, status: u.status, note: u.note, source: 'fred' }, { minMatch: 0.62 });
      console.log(`${r.ok ? (r.created ? 'new' : 'set') : 'skip'}: ${r.thread ? r.thread.title : u.thread} -> ${u.status}`);
    }
  }
  for (const t of store.all()) console.log(`  ${t.status.padEnd(11)} ${t.title}`);
  process.exit(0);
})();
