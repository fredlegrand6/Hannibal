// ── AGENTS PANEL ────────────────────────────────────────────────────────────
// Live view of every Claude Code session. Driven by the cc-ingest listener in the
// main process: hydrate once via window.hannibal.getSessions(), then live-update
// from the 'cc:event' push channel. Read-only — it shows state, sends nothing back.
// Matches Hannibal's glass-panel / HUD theme (no new visual language).
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_META = {
  active:  { label: 'ACTIVE',  color: 'var(--cyan)'  },
  working: { label: 'WORKING', color: 'var(--gold)'  },
  running: { label: 'RUNNING', color: 'var(--green)' },
  waiting: { label: 'WAITING', color: 'var(--amber)' },
  done:    { label: 'DONE',    color: 'var(--muted)' },
};
const ORDER = { running: 0, active: 1, working: 2, waiting: 3, done: 9 };
const DONE_TTL = 5 * 60 * 1000; // recent-done cards fade, then drop after 5 min

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Short machine tag for the hostname pill (Mac / gex131 / first label).
function shortHost(h) {
  if (!h) return '?';
  const base = String(h).split('.')[0];
  if (/macbook|mac-?mini|imac|fred-?mac/i.test(base)) return 'Mac';
  if (/gex131/i.test(base)) return 'gex131';
  return base.length > 12 ? base.slice(0, 12) : base;
}

function elapsed(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return m + 'm ' + r + 's';
  const h = Math.floor(m / 60); return h + 'h ' + (m % 60) + 'm';
}

export function initAgents() {
  const listEl = document.getElementById('agentsList');
  const badgeEl = document.getElementById('agentsBadge');
  if (!listEl) return;

  if (!window.hannibal || !window.hannibal.getSessions) {
    listEl.innerHTML = '<div class="agents-empty">Agents-bridge ontbreekt — herstart de app volledig (preload gewijzigd).</div>';
    return;
  }

  const sessions = new Map(); // session_id -> entry

  const upsert = (s) => { if (s && s.session_id) sessions.set(s.session_id, s); };

  function render() {
    const now = Date.now();
    for (const [id, s] of sessions) {            // prune long-done
      if (s.status === 'done' && (now - (s.updatedAt || 0)) > DONE_TTL) sessions.delete(id);
    }
    const list = [...sessions.values()].sort((a, b) => {
      const d = (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5);
      return d !== 0 ? d : (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    if (badgeEl) badgeEl.textContent = list.filter((s) => s.status !== 'done').length;

    if (!list.length) {
      listEl.innerHTML = '<div class="agents-empty">Geen actieve agents.</div>';
      return;
    }

    listEl.innerHTML = list.map((s) => {
      const meta = STATUS_META[s.status] || STATUS_META.active;
      const statusLabel = (s.status === 'running' && s.lastTool)
        ? `RUNNING ${esc(String(s.lastTool).toUpperCase())}` : meta.label;
      return `
      <div class="agent-card ${esc(s.status)}" data-id="${esc(s.session_id)}">
        <div class="agent-row">
          <span class="agent-proj">${esc(s.project || 'unknown')}</span>
          <span class="agent-host">${esc(shortHost(s.hostname))}</span>
        </div>
        <div class="agent-row2">
          <span class="agent-status" style="color:${meta.color}">${statusLabel}</span>
          <span class="agent-elapsed" data-started="${s.startedAt || now}">${elapsed(now - (s.startedAt || now))}</span>
        </div>
        <div class="agent-action">${esc(s.lastAction || '')}</div>
      </div>`;
    }).join('');
  }

  // Tick elapsed timers in place every second; only rebuild when a done card expires.
  function tick() {
    const now = Date.now();
    for (const el of listEl.querySelectorAll('.agent-elapsed')) {
      el.textContent = elapsed(now - (Number(el.dataset.started) || now));
    }
    for (const s of sessions.values()) {
      if (s.status === 'done' && (now - (s.updatedAt || 0)) > DONE_TTL) { render(); break; }
    }
  }

  // Hydrate from the main-process map, then go live.
  window.hannibal.getSessions()
    .then((rows) => { (rows || []).forEach(upsert); render(); })
    .catch(() => render());

  window.hannibal.onCcEvent((payload) => {
    if (payload && payload.sessionState) { upsert(payload.sessionState); render(); }
  });

  setInterval(tick, 1000);
}
