import { Router } from 'express';
import crypto from 'crypto';
import { query } from '../db/pool.js';

const router = Router();
const ADMIN_KEY = process.env.BETA_ADMIN_KEY;
if (!ADMIN_KEY) {
  console.error('[Playtest] CRITICAL: BETA_ADMIN_KEY env var not set. Admin endpoints will be DISABLED.');
}

// Timing-safe string comparison to prevent timing attacks
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// Brute force protection: track failed admin attempts per IP
const adminFailures = new Map();
function checkAdminBruteForce(ip) {
  const now = Date.now();
  const entry = adminFailures.get(ip) || { count: 0, lockedUntil: 0 };
  if (entry.lockedUntil > now) {
    return { blocked: true, retryIn: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  return { blocked: false };
}
function recordAdminFailure(ip) {
  const now = Date.now();
  const entry = adminFailures.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= 5) {
    entry.lockedUntil = now + 15 * 60 * 1000; // 15 min lockout
    entry.count = 0;
    console.warn(`[Playtest] Admin brute force lockout for ${ip}`);
  }
  adminFailures.set(ip, entry);
}
function clearAdminFailures(ip) {
  adminFailures.delete(ip);
}
// Cleanup old entries every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of adminFailures) {
    if (entry.lockedUntil < now && entry.count === 0) adminFailures.delete(ip);
  }
}, 30 * 60 * 1000);

// ---------------------------------------------------------------
// Redeem a playtest code (requires twitter session)
// ---------------------------------------------------------------
router.post('/redeem', async (req, res) => {
  const { code, session } = req.body;

  if (!code || !session) {
    return res.status(400).json({ error: 'Missing code or session' });
  }

  // Verify twitter session
  const user = verifySession(session);
  if (!user) {
    return res.status(401).json({ error: 'Invalid session. Connect X first.' });
  }

  // Clean code input
  const cleanCode = code.trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,16}$/.test(cleanCode)) {
    return res.status(400).json({ error: 'Invalid code format' });
  }

  try {
    // Check if user already has access
    const existing = await query(
      'SELECT id FROM beta_access WHERE twitter_id = $1', [user.id]
    );
    if (existing.rows.length > 0) {
      return res.json({ success: true, message: 'Already have access' });
    }

    // Find the code
    const codeResult = await query(
      'SELECT * FROM beta_codes WHERE code = $1', [cleanCode]
    );
    if (codeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid code' });
    }

    const betaCode = codeResult.rows[0];

    // Check expiry
    if (betaCode.expires_at && new Date(betaCode.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Code expired' });
    }

    // Check uses
    if (betaCode.used_count >= betaCode.max_uses) {
      return res.status(410).json({ error: 'Code fully redeemed' });
    }

    // Redeem
    await query(
      'INSERT INTO beta_access (twitter_id, username, code_used) VALUES ($1, $2, $3)',
      [user.id, user.username, cleanCode]
    );
    await query(
      'UPDATE beta_codes SET used_count = used_count + 1 WHERE code = $1',
      [cleanCode]
    );

    console.log(`[Playtest] @${user.username} redeemed code ${cleanCode}`);
    res.json({ success: true, message: 'Welcome to the playtest!' });

  } catch (err) {
    console.error('[Playtest] Redeem error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------
// Check playtest access (by session)
// ---------------------------------------------------------------
router.get('/check', async (req, res) => {
  const session = req.query.session || req.headers['x-session'];
  if (!session) return res.json({ access: false });

  const user = verifySession(session);
  if (!user) return res.json({ access: false });

  try {
    const result = await query(
      'SELECT id FROM beta_access WHERE twitter_id = $1', [user.id]
    );
    res.json({ access: result.rows.length > 0, username: user.username });
  } catch (err) {
    res.json({ access: false });
  }
});

// ---------------------------------------------------------------
// Admin: generate codes
// ---------------------------------------------------------------
router.post('/admin/generate', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Admin disabled' });

  const lockCheck = checkAdminBruteForce(ip);
  if (lockCheck.blocked) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${lockCheck.retryIn}s` });
  }

  const { adminKey, count, maxUses, label, expiresIn } = req.body;

  if (!safeEqual(adminKey, ADMIN_KEY)) {
    recordAdminFailure(ip);
    return res.status(403).json({ error: 'Unauthorized' });
  }
  clearAdminFailures(ip);

  const n = Math.min(Math.max(parseInt(count) || 1, 1), 100);
  const uses = Math.min(Math.max(parseInt(maxUses) || 1, 1), 1000);
  const safeLabel = typeof label === 'string' ? label.slice(0, 64).replace(/[<>]/g, '') : null;
  const expiry = expiresIn
    ? new Date(Date.now() + Math.min(parseInt(expiresIn) || 0, 8760) * 60 * 60 * 1000) // max 1 year
    : null;

  const codes = [];
  for (let i = 0; i < n; i++) {
    const code = 'HOP-' +
      crypto.randomBytes(2).toString('hex').toUpperCase() + '-' +
      crypto.randomBytes(2).toString('hex').toUpperCase();

    try {
      await query(
        `INSERT INTO beta_codes (code, max_uses, label, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [code, uses, safeLabel, expiry]
      );
      codes.push(code);
    } catch (err) {
      console.warn('[Playtest] Code collision, skipping');
    }
  }

  console.log(`[Playtest] Generated ${codes.length} codes (max ${uses} uses each)`);
  res.json({ codes, maxUses: uses, expires: expiry });
});

// ---------------------------------------------------------------
// Admin: list codes
// ---------------------------------------------------------------
router.get('/admin/codes', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Admin disabled' });

  const lockCheck = checkAdminBruteForce(ip);
  if (lockCheck.blocked) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${lockCheck.retryIn}s` });
  }

  const adminKey = req.query.adminKey;
  if (!safeEqual(adminKey, ADMIN_KEY)) {
    recordAdminFailure(ip);
    return res.status(403).json({ error: 'Unauthorized' });
  }
  clearAdminFailures(ip);

  try {
    const result = await query(
      `SELECT code, max_uses, used_count, label, created_at, expires_at
       FROM beta_codes ORDER BY created_at DESC LIMIT 100`
    );
    const access = await query(
      `SELECT username, code_used, granted_at
       FROM beta_access ORDER BY granted_at DESC LIMIT 100`
    );
    res.json({ codes: result.rows, access: access.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------
// Session verification helper
// ---------------------------------------------------------------
function verifySession(token) {
  try {
    const secret = process.env.TWITTER_CLIENT_SECRET;
    if (!secret) return null;
    const [session, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', secret)
      .update(session).digest('base64url');
    if (sig !== expected) return null;
    const data = JSON.parse(Buffer.from(session, 'base64url').toString());
    if (Date.now() - data.ts > 7 * 24 * 60 * 60 * 1000) return null;
    return data;
  } catch (e) {
    return null;
  }
}

export default router;
