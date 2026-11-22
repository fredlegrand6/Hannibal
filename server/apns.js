// ─────────────────────────────────────────────────────────────────────────
// PUSH — notifications to Fred's iPhone through Apple (APNs).
//
// Used when the Hannibal iPhone app is closed or in the background:
// reminders, the morning brief, and Yes/No questions (answered right on the
// lock screen). Nothing extra to install: Node's own http2 + crypto.
//
// Settings (.env on the Mac, copied to the server by deploy.sh):
//   APNS_KEY_B64   the .p8 push key from Fred's Apple developer account, base64
//   APNS_KEY_ID    that key's 10-character id
//   APNS_TEAM_ID   Fred's team id (X4GXK2YQW8)
//   APNS_TOPIC     the app's bundle id (default com.revalisgroup.hannibal)
// The app tells the server its device token (and sandbox/production) itself.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const http2 = require('http2');
const crypto = require('crypto');
const fs = require('fs');

const HOSTS = { sandbox: 'api.sandbox.push.apple.com', production: 'api.push.apple.com' };
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function makeJwt({ keyPem, keyId, teamId, now = Date.now() }) {
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: keyPem, dsaEncoding: 'ieee-p1363' });
  return `${head}.${claims}.${b64url(sig)}`;
}

// Real sender: one short HTTP/2 connection per push (pushes are rare).
function http2Send({ host, path, headers, body, timeoutMs = 10000 }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { client.close(); } catch (_) {} resolve(r); };
    const client = http2.connect(`https://${host}`);
    client.on('error', (e) => finish({ status: 0, error: e.message }));
    const req = client.request({ ':method': 'POST', ':path': path, ...headers });
    let status = 0; let text = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (c) => { text += c; });
    req.on('end', () => finish({ status, body: text }));
    req.on('error', (e) => finish({ status: 0, error: e.message }));
    req.setTimeout(timeoutMs, () => { try { req.close(); } catch (_) {} finish({ status: 0, error: 'timeout' }); });
    req.end(body);
  });
}

function createPush(opts = {}) {
  const log = opts.log || ((...a) => console.log('[push]', ...a));
  const keyPem = opts.keyPem || (opts.keyB64 ? Buffer.from(String(opts.keyB64), 'base64').toString('utf8') : '');
  const keyId = String(opts.keyId || '').trim();
  const teamId = String(opts.teamId || '').trim();
  const topic = opts.topic || 'com.revalisgroup.hannibal';
  const send = opts.sendImpl || http2Send;
  const filePath = opts.filePath;
  const configured = !!(keyPem && keyId && teamId);

  let tokens = [];
  try { if (filePath) tokens = JSON.parse(fs.readFileSync(filePath, 'utf8')).filter((t) => t && t.token); } catch (_) {}
  const save = () => { try { if (filePath) fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2)); } catch (e) { log('could not save tokens:', e.message); } };

  let jwt = null; let jwtAt = 0;
  const bearer = () => {
    if (!jwt || Date.now() - jwtAt > 45 * 60 * 1000) { jwt = makeJwt({ keyPem, keyId, teamId }); jwtAt = Date.now(); }
    return jwt;
  };

  function register(token, env) {
    const t = String(token || '').trim().toLowerCase();
    if (!/^[0-9a-f]{32,200}$/.test(t)) return false;
    const e = env === 'production' ? 'production' : 'sandbox';
    tokens = [{ token: t, env: e, at: new Date().toISOString() }, ...tokens.filter((x) => x.token !== t)].slice(0, 5);
    save();
    return true;
  }

  /** Sends to every registered iPhone. Returns how many accepted it. */
  async function notify({ title = 'Hannibal', body, category, data = {}, threadId } = {}) {
    if (!configured || !tokens.length || !body) return 0;
    const payload = JSON.stringify({
      aps: { alert: { title, body: String(body).slice(0, 1500) }, sound: 'default', ...(category ? { category } : {}), ...(threadId ? { 'thread-id': threadId } : {}) },
      ...data,
    });
    let ok = 0;
    for (const t of [...tokens]) {
      const r = await send({
        host: HOSTS[t.env] || HOSTS.sandbox,
        path: `/3/device/${t.token}`,
        headers: { authorization: `bearer ${bearer()}`, 'apns-topic': topic, 'apns-push-type': 'alert', 'apns-priority': '10', 'content-type': 'application/json' },
        body: payload,
      });
      if (r.status === 200) { ok += 1; continue; }
      const reason = (() => { try { return JSON.parse(r.body || '{}').reason; } catch (_) { return ''; } })() || r.error || '';
      log(`push to …${t.token.slice(-6)} failed: ${r.status} ${reason}`);
      // Token no longer valid (app deleted, or a sandbox token sent to production): forget it.
      if (r.status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(reason)) {
        tokens = tokens.filter((x) => x.token !== t.token); save();
      }
      if (r.status === 403 && /ExpiredProviderToken|InvalidProviderToken/.test(reason)) jwt = null;
    }
    return ok;
  }

  return { configured, register, notify, count: () => tokens.length, _tokens: () => tokens };
}

module.exports = { createPush, makeJwt };
