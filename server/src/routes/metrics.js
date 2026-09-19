/**
 * Metrics Aggregation API
 * Part 3 of the Hopping Heads metrics build
 *
 * All endpoints require X-Metrics-Secret header matching METRICS_SECRET env var.
 * Uses timing-safe comparison to prevent timing attacks on the secret.
 */

import { Router } from 'express';
import crypto from 'crypto';
import pool from '../db/pool.js';

const router = Router();

// -- Admin auth middleware ----------------------------------------------------

function requireMetricsAuth(req, res, next) {
  const secret = process.env.METRICS_SECRET;
  if (!secret) {
    console.error('[Metrics] METRICS_SECRET env var not set');
    return res.status(503).json({ error: 'Metrics not configured' });
  }

  const provided = req.headers['x-metrics-secret'] || '';
  if (typeof provided !== 'string' || provided.length === 0) {
    return res.status(401).json({ error: 'Missing auth' });
  }

  // Timing-safe comparison
  const a = Buffer.from(secret, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Invalid auth' });
  }

  next();
}

router.use(requireMetricsAuth);

// -- GET /overview ------------------------------------------------------------

router.get('/overview', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                                          AS total_events,
        COUNT(DISTINCT ip_hash) FILTER (WHERE ip_hash IS NOT NULL)::int        AS unique_visitors,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int  AS events_24h,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int    AS events_7d,
        COUNT(DISTINCT ip_hash) FILTER (
          WHERE ip_hash IS NOT NULL AND created_at > NOW() - INTERVAL '24 hours'
        )::int AS visitors_24h,
        COUNT(DISTINCT ip_hash) FILTER (
          WHERE ip_hash IS NOT NULL AND created_at > NOW() - INTERVAL '7 days'
        )::int AS visitors_7d,
        MIN(created_at)::text AS first_event,
        MAX(created_at)::text AS last_event
      FROM events
    `);
    res.json(rows[0] || {});
  } catch (err) {
    console.error('[Metrics] Overview error:', err.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

// -- GET /events --------------------------------------------------------------

router.get('/events', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        event_name,
        COUNT(*)::int AS count,
        COUNT(DISTINCT ip_hash) FILTER (WHERE ip_hash IS NOT NULL)::int AS unique_ips,
        MAX(created_at)::text AS last_seen,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS count_24h
      FROM events
      GROUP BY event_name
      ORDER BY count DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[Metrics] Events breakdown error:', err.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

// -- GET /timeline ------------------------------------------------------------

router.get('/timeline', async (req, res) => {
  try {
    // Whitelist interval -- no injection
    const interval = req.query.interval === 'day' ? 'day' : 'hour';
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);

    const { rows } = await pool.query(`
      SELECT
        date_trunc($1, created_at)::text AS bucket,
        COUNT(*)::int AS count,
        COUNT(DISTINCT ip_hash) FILTER (WHERE ip_hash IS NOT NULL)::int AS unique_ips
      FROM events
      WHERE created_at > NOW() - make_interval(days => $2)
      GROUP BY bucket
      ORDER BY bucket ASC
    `, [interval, days]);

    res.json({ interval, days, data: rows });
  } catch (err) {
    console.error('[Metrics] Timeline error:', err.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

// -- GET /funnel --------------------------------------------------------------

router.get('/funnel', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);

    const stages = [
      'page_view',
      'coin_insert',
      'game_start',
      'quickmatch_join',
      'fragment_collected',
      'round_end'
    ];

    const { rows } = await pool.query(`
      SELECT
        event_name,
        COUNT(DISTINCT ip_hash)::int AS unique_users,
        COUNT(*)::int AS total_events
      FROM events
      WHERE event_name = ANY($1)
        AND created_at > NOW() - make_interval(days => $2)
        AND ip_hash IS NOT NULL
      GROUP BY event_name
    `, [stages, days]);

    const lookup = {};
    for (const r of rows) lookup[r.event_name] = r;

    const funnel = stages.map((stage, i) => {
      const data = lookup[stage] || { unique_users: 0, total_events: 0 };
      const prev = i > 0 ? (lookup[stages[i - 1]]?.unique_users || 0) : data.unique_users;
      return {
        stage,
        unique_users: data.unique_users,
        total_events: data.total_events,
        conversion: prev > 0 ? Math.round((data.unique_users / prev) * 100) : 0
      };
    });

    res.json({ days, funnel });
  } catch (err) {
    console.error('[Metrics] Funnel error:', err.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

// -- GET /maps ----------------------------------------------------------------

router.get('/maps', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(
          (props->>'map')::text,
          (props->>'mapIndex')::text,
          'unknown'
        ) AS map_id,
        COUNT(*)::int AS plays,
        COUNT(DISTINCT ip_hash)::int AS unique_players
      FROM events
      WHERE event_name IN ('game_start', 'round_end')
        AND props IS NOT NULL
      GROUP BY map_id
      ORDER BY plays DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[Metrics] Maps error:', err.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

// -- GET /retention -----------------------------------------------------------

router.get('/retention', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH first_seen AS (
        SELECT ip_hash, MIN(created_at::date) AS first_day
        FROM events
        WHERE ip_hash IS NOT NULL
        GROUP BY ip_hash
      ),
      daily_visits AS (
        SELECT DISTINCT ip_hash, created_at::date AS visit_day
        FROM events
        WHERE ip_hash IS NOT NULL
      )
      SELECT
        (dv.visit_day - fs.first_day) AS day_number,
        COUNT(DISTINCT dv.ip_hash)::int AS returning_users
      FROM daily_visits dv
      JOIN first_seen fs ON dv.ip_hash = fs.ip_hash
      WHERE (dv.visit_day - fs.first_day) <= 14
      GROUP BY day_number
      ORDER BY day_number ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[Metrics] Retention error:', err.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

// -- GET /live ----------------------------------------------------------------

router.get('/live', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, event_name, ip_hash, created_at::text,
        CASE WHEN props IS NOT NULL THEN props ELSE '{}'::jsonb END AS props
      FROM events
      ORDER BY created_at DESC
      LIMIT 50
    `);
    res.json(rows);
  } catch (err) {
    console.error('[Metrics] Live feed error:', err.message);
    res.status(500).json({ error: 'Query failed' });
  }
});

export default router;
