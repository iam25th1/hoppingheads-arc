/**
 * Updated /track endpoint -- drop this into your existing route file
 * or index.js, replacing the current /track POST handler.
 * 
 * Changes from Part 1-2:
 * - Accepts optional `data` JSONB field for event metadata
 * - Validates data size (max 2KB stringified)
 * - Validates event_name against a whitelist
 * - Strips any unexpected fields from the body
 */

// ── Whitelist of valid event names ───────────────────────────────────────────
const VALID_EVENTS = new Set([
  'page_view',
  'coin_insert',
  'game_start',
  'game_end',
  'round_end',
  'quickmatch_join',
  'quickmatch_leave',
  'fragment_collected',
  'mint_start',
  'mint_done',
  'boink',
  'map_load',
  'menu_open',
  'skin_change',
  'settings_change',
  'leaderboard_view',
  'wallet_connect',
  'wallet_disconnect',
  'error'
]);

// ── Rate limiter for /track (per IP) ─────────────────────────────────────────
const trackLimiter = new Map();  // ip -> { count, resetAt }
const TRACK_LIMIT = 120;        // max events per window
const TRACK_WINDOW = 60000;     // 1 minute window

function checkTrackRate(ip) {
  const now = Date.now();
  let entry = trackLimiter.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + TRACK_WINDOW };
    trackLimiter.set(ip, entry);
  }
  entry.count++;
  return entry.count <= TRACK_LIMIT;
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of trackLimiter) {
    if (now > entry.resetAt) trackLimiter.delete(ip);
  }
}, 300000);

// ── The endpoint ─────────────────────────────────────────────────────────────

app.post('/track', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();

    // Rate limit check
    if (!checkTrackRate(ip)) {
      return res.status(429).json({ error: 'Too many events' });
    }

    const { event_name, data } = req.body || {};

    // Validate event_name
    if (!event_name || typeof event_name !== 'string') {
      return res.status(400).json({ error: 'Missing event_name' });
    }
    if (!VALID_EVENTS.has(event_name)) {
      return res.status(400).json({ error: 'Invalid event_name' });
    }

    // Hash IP for privacy (same as Part 1-2)
    const crypto = require('crypto');
    const ipHash = ip
      ? crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'hh-salt')).digest('hex').substring(0, 16)
      : null;

    // Validate and sanitize data field
    let safeData = null;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const str = JSON.stringify(data);
      if (str.length <= 2048) {  // 2KB max
        safeData = str;
      }
    }

    const pool = app.get('db');
    if (!pool) {
      return res.status(503).json({ error: 'DB unavailable' });
    }

    await pool.query(
      'INSERT INTO events (event_name, ip_hash, data) VALUES ($1, $2, $3)',
      [event_name, ipHash, safeData]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[Track] Error:', err.message);
    res.status(500).json({ error: 'Track failed' });
  }
});
