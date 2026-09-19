import { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import { query } from '../db/pool.js';

const router = Router();
const TWITTER_SECRET = process.env.TWITTER_CLIENT_SECRET;

// Rate limit: 60 events/min per IP
const rateLimits = new Map();
function checkRate(ip) {
  const now = Date.now();
  const e = rateLimits.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > e.resetAt) { e.count = 0; e.resetAt = now + 60000; }
  e.count++;
  rateLimits.set(ip, e);
  return e.count <= 60;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateLimits) if (now > e.resetAt + 120000) rateLimits.delete(ip);
}, 300000);

// Allowed event names (whitelist prevents noise injection)
const ALLOWED_EVENTS = new Set([
  'page_view','connect_x_click','connect_x_success','code_redeem_attempt',
  'code_redeem_success','game_load','game_start','game_end','mint_attempt',
  'mint_success','mint_done','boink','disconnect','skin_change','leaderboard_view',
  'settings_open','coin_insert','quickmatch_join','fragment_collected',
  'head_unlocked','round_end'
]);

function hashIp(ip) {
  return crypto.createHash('sha256').update(ip + (TWITTER_SECRET || '')).digest('hex').slice(0,16);
}

function verifySession(token) {
  if (!token || !TWITTER_SECRET) return null;
  try {
    const [s, sig] = token.split('.');
    if (!s || !sig) return null;
    const exp = crypto.createHmac('sha256', TWITTER_SECRET).update(s).digest('base64url');
    if (sig !== exp) return null;
    return JSON.parse(Buffer.from(s, 'base64url').toString());
  } catch { return null; }
}

// POST /api/track
router.post('/', express.text({ type: 'text/plain' }), async (req, res) => {
  // If global express.json() already parsed it, req.body is an object
  // If sendBeacon sent as text/plain, req.body is a string
  if (typeof req.body === 'string' && req.body.length > 0) {
    try { req.body = JSON.parse(req.body); } catch { return res.status(400).json({ ok: false }); }
  }
  if (!req.body || typeof req.body !== 'object') {
    console.warn('[Track] Empty/invalid body. Type:', typeof req.body, 'Content-Type:', req.headers['content-type']);
    return res.status(400).json({ ok: false });
  }
  const ip = req.ip || req.socket.remoteAddress;
  if (!checkRate(ip)) return res.status(429).json({ ok: false });

  const { event, session, sessionId, props, referrer, device, country } = req.body || {};
  if (!event || typeof event !== 'string' || !ALLOWED_EVENTS.has(event)) {
    return res.status(400).json({ ok: false });
  }

  const user = verifySession(session);
  const tid = user?.id || null;
  const uname = user?.username ? String(user.username).slice(0, 32) : null;
  const sid = typeof sessionId === 'string' ? sessionId.slice(0, 64) : null;
  const ref = typeof referrer === 'string' ? referrer.slice(0, 256) : null;
  const dev = typeof device === 'string' ? device.slice(0, 16) : null;
  const ctry = typeof country === 'string' ? country.slice(0, 4) : (req.headers['cf-ipcountry'] || null);
  const safeProps = (typeof props === 'object' && props !== null) ? props : {};

  try {
    await query(
      `INSERT INTO events (event_name,twitter_id,username,session_id,ip_hash,country,device,referrer,props)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [event, tid, uname, sid, hashIp(ip), ctry, dev, ref, JSON.stringify(safeProps)]
    );
    if (tid) {
      await query(
        `INSERT INTO user_first_seen (twitter_id, username, country)
         VALUES ($1, $2, $3)
         ON CONFLICT (twitter_id) DO UPDATE SET
           last_seen = NOW(),
           username = COALESCE(EXCLUDED.username, user_first_seen.username),
           total_games = user_first_seen.total_games + (CASE WHEN $4 = 'game_end' THEN 1 ELSE 0 END),
           total_mints = user_first_seen.total_mints + (CASE WHEN $4 = 'mint_success' THEN 1 ELSE 0 END)`,
        [tid, uname, ctry, event]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Track] DB Error:', err.message);
    res.status(500).json({ ok: false });
  }
});

export default router;
