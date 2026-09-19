/**
 * INDEX.JS PATCH -- Exact lines to add to server/src/index.js
 * ============================================================
 * 
 * Your current index.js has a structure roughly like:
 * 
 *   const express = require('express');
 *   const { Pool } = require('pg');
 *   ...
 *   const app = express();
 *   ...
 *   // middleware
 *   app.use(express.json());
 *   app.use(express.static('public'));
 *   ...
 *   // routes
 *   app.use('/api', require('./routes/api'));
 *   ...
 *   // socket.io setup
 *   ...
 *   // server listen
 * 
 * Here's exactly what to add and where:
 */


// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 1: After creating the pool, expose it on the app
// ═══════════════════════════════════════════════════════════════════════════════
//
// Find the line where your Pool is created, something like:
//   const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: ... });
//
// Add this line RIGHT AFTER it:

app.set('db', pool);

// This lets the metrics router access the pool via req.app.get('db')


// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 2: Mount the metrics router
// ═══════════════════════════════════════════════════════════════════════════════
//
// Find where your existing routes are mounted, like:
//   app.use('/api', apiRouter);
//   or
//   const apiRoutes = require('./routes/api');
//
// Add these lines AFTER the existing route mounts:

const metricsRouter = require('./routes/metrics');
app.use('/api/metrics', metricsRouter);


// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 3: Update the /track endpoint to accept data field
// ═══════════════════════════════════════════════════════════════════════════════
//
// Find your existing app.post('/track', ...) handler.
// Replace the INSERT query line. 
//
// BEFORE (Part 1-2):
//   await pool.query(
//     'INSERT INTO events (event_name, ip_hash) VALUES ($1, $2)',
//     [event_name, ipHash]
//   );
//
// AFTER (with data support):

const { event_name, data } = req.body || {};

// Validate event name against whitelist
const VALID_EVENTS = new Set([
  'page_view', 'coin_insert', 'game_start', 'game_end', 'round_end',
  'quickmatch_join', 'quickmatch_leave', 'fragment_collected',
  'mint_start', 'mint_done', 'boink', 'map_load', 'menu_open',
  'skin_change', 'settings_change', 'leaderboard_view',
  'wallet_connect', 'wallet_disconnect', 'error', 'page_unload'
]);

if (!event_name || !VALID_EVENTS.has(event_name)) {
  return res.status(400).json({ error: 'Invalid event' });
}

// Sanitize data -- must be object, max 2KB
let safeData = null;
if (data && typeof data === 'object' && !Array.isArray(data)) {
  const str = JSON.stringify(data);
  if (str.length <= 2048) safeData = str;
}

await pool.query(
  'INSERT INTO events (event_name, ip_hash, data) VALUES ($1, $2, $3)',
  [event_name, ipHash, safeData]
);


// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 4: Add migration to initDb (optional -- handles future deploys)
// ═══════════════════════════════════════════════════════════════════════════════
//
// In your initDb() function inside schema.sql or wherever the events table
// is created, add this after the CREATE TABLE IF NOT EXISTS events statement:
//
//   ALTER TABLE events ADD COLUMN IF NOT EXISTS data JSONB DEFAULT NULL;
//   CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
//   CREATE INDEX IF NOT EXISTS idx_events_name ON events(event_name);
//   CREATE INDEX IF NOT EXISTS idx_events_ip ON events(ip_hash);
//   CREATE INDEX IF NOT EXISTS idx_events_name_created ON events(event_name, created_at);
//
// This makes the schema self-healing -- new deploys auto-migrate.


// ═══════════════════════════════════════════════════════════════════════════════
// FILE PLACEMENT SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════
//
// metrics.js        -> server/src/routes/metrics.js
// metrics.html      -> server/public/metrics.html
// track-endpoint.js -> reference only (patch into existing /track handler)
// client-tracking.js -> reference only (add track() calls to client/index.html)
//
// Then:
//   cd C:\Users\Bright\Documents\GitHub\hoppingheads
//   git add -A
//   git commit -m "feat: metrics aggregation API + admin dashboard (Parts 3-4)"
//   git push
