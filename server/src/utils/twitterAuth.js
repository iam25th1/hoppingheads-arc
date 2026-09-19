/**
 * Twitter/X OAuth 2.0 Authentication
 * Uses Authorization Code flow with PKCE
 */

import crypto from 'crypto';
import { query } from '../db/pool.js';

const TWITTER_CLIENT_ID = process.env.TWITTER_CLIENT_ID;
const TWITTER_CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET;
const BASE_URL = (process.env.BASE_URL || 'https://hoppingheads.fun').replace(/\/$/, '');
const CALLBACK_URL = `${BASE_URL}/auth/twitter/callback`;

console.log('[Auth] BASE_URL:', BASE_URL);
console.log('[Auth] CALLBACK_URL:', CALLBACK_URL);

// Pending auth states (in-memory, short-lived)
const pendingAuth = new Map();

// Clean up old pending auths every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of pendingAuth) {
    if (now - data.created > 300000) pendingAuth.delete(state);
  }
}, 300000);

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function setupTwitterAuth(app) {
  if (!TWITTER_CLIENT_ID || !TWITTER_CLIENT_SECRET) {
    console.warn('[Auth] Twitter credentials not set, OAuth disabled');
    app.get('/auth/twitter', (req, res) => res.json({ error: 'Twitter auth not configured' }));
    return;
  }

  console.log('[Auth] Twitter OAuth enabled');

  // Step 1: Redirect to Twitter
  app.get('/auth/twitter', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    pendingAuth.set(state, {
      codeVerifier,
      redirect: req.query.redirect || 'play',
      created: Date.now(),
    });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: TWITTER_CLIENT_ID,
      redirect_uri: CALLBACK_URL,
      scope: 'tweet.read users.read',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    res.redirect(`https://twitter.com/i/oauth2/authorize?${params}`);
    console.log('[Auth] Redirecting to Twitter authorize');
  });

  // Step 2: Twitter callback
  app.get('/auth/twitter/callback', async (req, res) => {
    const { code, state, error } = req.query;
    console.log('[Auth] Callback received:', error ? 'error='+error : 'code='+code?.slice(0,10)+'...');

    if (error) {
      return res.redirect(`${BASE_URL}/?auth=denied#beta`);
    }

    if (!code || !state) {
      return res.redirect(`${BASE_URL}/?auth=missing#beta`);
    }

    const pending = pendingAuth.get(state);
    if (!pending) {
      return res.redirect(`${BASE_URL}/?auth=expired#beta`);
    }

    pendingAuth.delete(state);

    try {
      // Exchange code for access token
      const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`).toString('base64'),
        },
        body: new URLSearchParams({
          code,
          grant_type: 'authorization_code',
          redirect_uri: CALLBACK_URL,
          code_verifier: pending.codeVerifier,
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error('[Auth] Token exchange failed:', errText);
        return res.redirect(`${BASE_URL}/?auth=token_failed#beta`);
      }

      const tokenData = await tokenRes.json();
      const accessToken = tokenData.access_token;

      // Fetch user profile
      const userRes = await fetch('https://api.twitter.com/2/users/me?user.fields=profile_image_url', {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      if (!userRes.ok) {
        const errText = await userRes.text();
        console.error('[Auth] User fetch failed:', errText);
        return res.redirect(`${BASE_URL}/?auth=user_failed#beta`);
      }

      const userData = await userRes.json();
      const user = userData.data;

      // Upsert twitter profile in DB
      try {
        await query(
          `INSERT INTO twitter_profiles (twitter_id, username, display_name, avatar_url, access_token, last_login)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (twitter_id) DO UPDATE SET
             username = $2, display_name = $3, avatar_url = $4,
             access_token = $5, last_login = NOW()`,
          [user.id, user.username, user.name, user.profile_image_url, accessToken]
        );

        await query(
          `INSERT INTO player_stats (player_name, total_score, total_wins, total_rounds, total_minted, best_score)
           VALUES ($1, 0, 0, 0, 0, 0)
           ON CONFLICT (player_name) DO NOTHING`,
          [user.username]
        );
      } catch (dbErr) {
        console.error('[Auth] DB error (continuing):', dbErr.message);
      }

      console.log(`[Auth] @${user.username} logged in`);

      // Create session
      const session = Buffer.from(JSON.stringify({
        id: user.id,
        username: user.username,
        name: user.name,
        avatar: user.profile_image_url,
        ts: Date.now(),
      })).toString('base64url');

      const sig = crypto.createHmac('sha256', TWITTER_CLIENT_SECRET)
        .update(session).digest('base64url');

      // Redirect destination based on where user came from
      let dest;
      if (pending.redirect === 'game') {
        dest = `https://play.hoppingheads.fun/game?session=${session}.${sig}`;
      } else if (pending.redirect === 'store') {
        dest = `${BASE_URL}/store?session=${session}.${sig}`;
      } else {
        dest = `${BASE_URL}/?session=${session}.${sig}#beta`;
      }
      console.log('[Auth] Redirecting to:', dest);
      res.redirect(dest);

    } catch (err) {
      console.error('[Auth] OAuth error:', err.message);
      res.redirect(`${BASE_URL}/?auth=error#beta`);
    }
  });

  // Verify session endpoint
  app.get('/auth/me', (req, res) => {
    const token = req.query.token || req.headers['x-session'];
    if (!token) return res.json({ user: null });

    try {
      const [session, sig] = token.split('.');
      const expected = crypto.createHmac('sha256', TWITTER_CLIENT_SECRET)
        .update(session).digest('base64url');

      if (sig !== expected) return res.json({ user: null });

      const data = JSON.parse(Buffer.from(session, 'base64url').toString());
      // Expire after 7 days
      if (Date.now() - data.ts > 7 * 24 * 60 * 60 * 1000) return res.json({ user: null });

      res.json({ user: { username: data.username, name: data.name, avatar: data.avatar } });
    } catch (e) {
      res.json({ user: null });
    }
  });
}
