// ─────────────────────────────────────────────────────────────────────────
// PHONE ORB — a light 2D-canvas version of the desk's neural brain
// (src/neural-brain.js), sized for an iPhone home-screen app.
// No libraries, nothing downloaded. States: idle, listening, thinking,
// speaking, confirm (gold while a Yes/No is waiting).
// Purely visual: if it fails to draw, the app works exactly as before.
// The browser pauses it while the app is in the background.
// ─────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';
  function initOrb(canvas) {
    const ctx = canvas.getContext('2d');
    // Respect "Reduce Motion": draw a calm still frame instead of animating.
    const still = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const N = 170, LINK = 0.55, LMAX = 4;
    const rnd = Math.random;
    const noise3 = (x, y, z) => (Math.sin(x + y * 1.7 + z * 0.3) + Math.sin(y * 1.3 + z * 1.9 + x * 0.5) + Math.sin(z * 1.1 + x * 2.1 + y * 0.7)) / 3;
    const pts = [];
    while (pts.length < N) {
      const th = Math.acos(2 * rnd() - 1), ph = 2 * Math.PI * rnd();
      const r = 0.62 + 0.38 * Math.pow(rnd(), 0.4);
      let x = r * Math.sin(th) * Math.cos(ph), y = r * Math.cos(th), z = r * Math.sin(th) * Math.sin(ph);
      const d = 1 + 0.13 * noise3(x * 3, y * 3, z * 3); x *= d * 1.15; y *= d * 0.95; z *= d * 1.45;
      if (Math.abs(x) < 0.13 && y > -0.15) { x += (x >= 0 ? 1 : -1) * 0.13; y -= 0.07; }
      const tier = rnd();
      pts.push({ x, y, z, seed: rnd() * 100, fire: -100,
        s: tier < 0.2 ? 1.5 + rnd() * 0.5 : tier < 0.7 ? 0.85 + rnd() * 0.35 : 0.45 + rnd() * 0.25,
        b: tier < 0.2 ? 1.25 + rnd() * 0.25 : tier < 0.7 ? 0.8 + rnd() * 0.2 : 0.4 + rnd() * 0.18 });
    }
    const links = []; const deg = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      const near = [];
      for (let j = i + 1; j < N; j++) { const a = pts[i], b = pts[j]; const dd = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); if (dd < LINK) near.push([j, dd]); }
      near.sort((p, q) => p[1] - q[1]);
      for (const [j, dd] of near) { if (deg[i] >= LMAX) break; if (deg[j] >= LMAX) continue; deg[i]++; deg[j]++; links.push([i, j, 0.5 + 0.5 * (1 - dd / LINK)]); }
    }
    // pre-rendered glow sprites (cyan and gold)
    function sprite(rgb) {
      const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.16, `rgba(${rgb},1)`); gr.addColorStop(0.4, `rgba(${rgb},.35)`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return c;
    }
    const CYAN = '0,229,255', GOLD = '212,162,76';
    const sCyan = sprite(CYAN), sGold = sprite(GOLD);

    let state = 'idle', stateT = 0, amp = 0, ampTarget = 0;
    const w8 = { listening: 0, thinking: 0, speaking: 0, confirm: 0 };
    let W = 0, H = 0, dpr = 1, rot = 0, breathe = 0, last = performance.now(), t = 0, fireAcc = 0;
    function size() {
      if (still) requestAnimationFrame(frame);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    }
    size(); window.addEventListener('resize', size);
    if (window.ResizeObserver) new ResizeObserver(size).observe(canvas);
    if (!ctx) return { setState() {}, setAmplitude() {}, pulse() {}, getState: () => 'idle' };

    const proj = new Array(N);
    let skip = 0;
    function frame(now) {
      // At rest it draws at half rate (about 30 a second) to spare the battery.
      if (!still && (state === 'idle' || state === 'confirm') && (skip++ & 1)) { requestAnimationFrame(frame); return; }
      const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt; stateT += dt;
      const k = still ? 1 : 1 - Math.pow(0.001, dt);
      for (const key in w8) w8[key] += ((state === key ? 1 : 0) - w8[key]) * k;
      if (state === 'speaking' && !extAmp) ampTarget = 0.25 + 0.75 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 2.9 + 1));
      if (state !== 'speaking' && state !== 'listening') ampTarget = 0;
      amp += (ampTarget - amp) * Math.min(1, dt * 14);

      breathe += dt * (Math.PI * 2 / 4) * (1 + w8.listening * 1.4 + w8.thinking * 0.8);
      const scale = 1 + 0.02 * (1 + w8.listening * 0.6 + w8.speaking * 0.3) * Math.sin(breathe);
      rot += dt * 0.12 * (1 + w8.thinking * 0.8);
      fireAcc += dt * (2.5 + w8.thinking * 6);
      while (fireAcc >= 1) { pts[(rnd() * N) | 0].fire = t; fireAcc -= 1; }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      const R = Math.min(W, H) * 0.36 * scale, cx = W / 2, cy = H / 2;
      const cr = Math.cos(rot), sr = Math.sin(rot), tilt = 0.18, ct = Math.cos(tilt), st = Math.sin(tilt);
      const tSpeed = 0.3 + stateT * 0.12, f1 = (stateT * tSpeed % 1) * 2.4, f2 = ((stateT * tSpeed + 0.5) % 1) * 2.4;
      for (let i = 0; i < N; i++) {
        const p = pts[i];
        let x = p.x * cr + p.z * sr, z = -p.x * sr + p.z * cr, y = p.y;
        const y2 = y * ct - z * st; z = y * st + z * ct; y = y2;
        const persp = 3.2 / (3.2 - z);
        const rad = Math.hypot(p.x, p.y, p.z);
        const since = t - p.fire, fire = since >= 0 ? Math.exp(-since * 5) : 0;
        const tw = 0.85 + 0.15 * Math.sin(t * (0.8 + p.seed * 0.06) + p.seed * 6.28);
        const left = Math.min(1, Math.max(0, -x / 0.65));
        const listen = w8.listening * left * (0.5 + 0.5 * Math.sin(t * 5 + rad * 2.5)) * (1.2 + amp * 1.6);
        const think = w8.thinking * (Math.exp(-Math.pow((rad - f1) * 4, 2)) + Math.exp(-Math.pow((rad - f2) * 4, 2))) * 2.6;
        const speak = w8.speaking * (0.5 + 0.5 * Math.sin(rad * 3.5 - t * 6)) * (0.6 + amp * 1.8);
        const fade = 0.45 + 0.55 * (z + 1.5) / 3;
        proj[i] = { x: cx + x * R * persp, y: cy - y * R * persp, p: persp, br: (p.b * tw + fire * 2.2 + listen + think + speak) * fade, s: p.s * (1 + fire * 0.6 + think * 0.12) };
      }
      ctx.lineWidth = 1.3;
      const lineRGB = w8.confirm > 0.5 ? GOLD : CYAN;
      ctx.strokeStyle = `rgb(${lineRGB})`;
      for (const [i, j, c] of links) {
        const a = proj[i], b = proj[j];
        const al = Math.min(1, c * 0.32 * (a.br + b.br) * 0.5);
        if (al < 0.03) continue;
        ctx.globalAlpha = al; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      const base = R * 0.11;
      for (let i = 0; i < N; i++) {
        const q = proj[i], d = base * q.s * q.p * 1.9;
        ctx.globalAlpha = Math.min(1, q.br * 0.75);
        ctx.drawImage(w8.confirm > 0.5 ? sGold : sCyan, q.x - d / 2, q.y - d / 2, d, d);
      }
      // centre orb: core + halo, grows with the voice
      const pulse = 0.85 + 0.15 * Math.sin(t * 1.6);
      const orbR = R * (0.3 + amp * 0.12 * (w8.speaking + w8.listening)) * pulse;
      const rgb = w8.confirm > 0.5 ? GOLD : CYAN;
      ctx.globalAlpha = 1;
      let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbR * 3.2);
      g.addColorStop(0, `rgba(${rgb},.32)`); g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, orbR * 3.2, 0, 7); ctx.fill();
      g = ctx.createRadialGradient(cx, cy, orbR * 0.2, cx, cy, orbR);
      g.addColorStop(0, `rgba(${rgb},.25)`); g.addColorStop(0.75, `rgba(${rgb},.55)`); g.addColorStop(0.92, 'rgba(255,255,255,.55)'); g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, orbR, 0, 7); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      if (!still) requestAnimationFrame(frame);
    }
    let extAmp = false;
    requestAnimationFrame(frame);
    return {
      setState(s) { if (s !== state) { state = s; stateT = 0; extAmp = false; if (still) requestAnimationFrame(frame); } },
      setAmplitude(v) { extAmp = true; ampTarget = Math.max(0, Math.min(1, +v || 0)); },
      pulse(n = 40) { for (let i = 0; i < n; i++) pts[(rnd() * N) | 0].fire = t; },
      getState: () => state,
    };
  }
  window.initOrb = initOrb;
})();
