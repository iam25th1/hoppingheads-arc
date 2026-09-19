/**
 * Store Routes
 *
 * Handles the in-game store: browsing catalog, purchasing items,
 * managing inventory, and equipping loadout slots.
 *
 * Security:
 *   - All mutations require authenticated twitter session
 *   - Purchases wrapped in DB transactions (no double-spend)
 *   - Balance checked server-side before deducting
 *   - Supply limits enforced atomically
 *   - Rate limiting on purchase endpoint
 *   - All inputs sanitized and validated
 */

import { Router } from "express";
import { query, getClient } from "../db/pool.js";

const router = Router();

// Valid categories and rarities for input validation
const VALID_CATEGORIES = [
  "skin", "skin_color", "eye_style", "headwear",
  "trail_effect", "glow_color", "name_color",
  "victory_anim", "badge"
];
const VALID_RARITIES = ["common", "uncommon", "rare", "epic", "legendary"];

// Simple in-memory rate limiter for purchases
const purchaseTimestamps = new Map();
const PURCHASE_COOLDOWN_MS = 2000; // 2s between purchases

function checkPurchaseRate(twitterId) {
  const now = Date.now();
  const last = purchaseTimestamps.get(twitterId) || 0;
  if (now - last < PURCHASE_COOLDOWN_MS) return false;
  purchaseTimestamps.set(twitterId, now);
  return true;
}

// Cleanup stale rate limit entries every 10 min
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [k, v] of purchaseTimestamps) {
    if (v < cutoff) purchaseTimestamps.delete(k);
  }
}, 600000);

// ---------------------------------------------------------------
// Session middleware -- verifies signed session token, extracts twitter_id
// Token format: base64url(JSON).hmac_signature (same as beta/game system)
// ---------------------------------------------------------------

import crypto from "crypto";

function verifyStoreSession(token) {
  try {
    const secret = process.env.TWITTER_CLIENT_SECRET;
    if (!secret || !token || typeof token !== "string") return null;
    const [session, sig] = token.split(".");
    if (!session || !sig) return null;
    const expected = crypto.createHmac("sha256", secret).update(session).digest("base64url");
    if (sig !== expected) return null;
    const data = JSON.parse(Buffer.from(session, "base64url").toString());
    // Sessions older than 7 days are rejected
    if (Date.now() - data.ts > 7 * 24 * 60 * 60 * 1000) return null;
    return data; // { id, username, ts }
  } catch {
    return null;
  }
}

function storeAuth(req, res, next) {
  const session = req.headers["x-session"] || req.query.session;
  if (!session || typeof session !== "string" || session.length > 512) {
    return res.status(401).json({ error: "Missing or invalid session" });
  }

  const user = verifyStoreSession(session);
  if (!user || !user.id) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  // Verify user has playtest access
  query(
    "SELECT twitter_id, username FROM beta_access WHERE twitter_id = $1",
    [user.id]
  )
    .then((result) => {
      if (result.rows.length === 0) {
        return res.status(401).json({ error: "No playtest access" });
      }
      req.twitterId = result.rows[0].twitter_id;
      req.username = result.rows[0].username;
      next();
    })
    .catch((err) => {
      console.error("[Store] Auth error:", err.message);
      res.status(500).json({ error: "Auth check failed" });
    });
}

// ---------------------------------------------------------------
// Catalog -- public, no auth required
// ---------------------------------------------------------------

// GET /api/store/catalog
// Returns all active items, optionally filtered by category/rarity
router.get("/catalog", async (req, res) => {
  try {
    const { category, rarity } = req.query;
    const conditions = ["active = true"];
    const params = [];
    let idx = 1;

    // Only show items within their availability window
    conditions.push(
      "(available_from IS NULL OR available_from <= NOW())"
    );
    conditions.push(
      "(available_until IS NULL OR available_until > NOW())"
    );

    if (category) {
      if (!VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: "Invalid category" });
      }
      conditions.push(`category = $${idx++}`);
      params.push(category);
    }

    if (rarity) {
      if (!VALID_RARITIES.includes(rarity)) {
        return res.status(400).json({ error: "Invalid rarity" });
      }
      conditions.push(`rarity = $${idx++}`);
      params.push(rarity);
    }

    const result = await query(
      `SELECT id, slug, name, description, category, rarity, price_credits,
              config, traits, preview_url, is_default, locked, available_from, available_until,
              max_supply, total_sold
       FROM store_items
       WHERE ${conditions.join(" AND ")}
       ORDER BY category, rarity DESC, price_credits ASC`,
      params
    );

    res.json({ items: result.rows });
  } catch (err) {
    console.error("[Store] Catalog error:", err.message);
    res.status(500).json({ error: "Failed to load catalog" });
  }
});

// GET /api/store/catalog/:slug
// Single item details
router.get("/catalog/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug).slice(0, 64).replace(/[^a-z0-9_\-]/g, "");
    const result = await query(
      `SELECT id, slug, name, description, category, rarity, price_credits,
              config, traits, preview_url, is_default, locked, available_from, available_until,
              max_supply, total_sold
       FROM store_items WHERE slug = $1 AND active = true`,
      [slug]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.json({ item: result.rows[0] });
  } catch (err) {
    console.error("[Store] Item detail error:", err.message);
    res.status(500).json({ error: "Failed to load item" });
  }
});

// ---------------------------------------------------------------
// Player Balance
// ---------------------------------------------------------------

// GET /api/store/balance
router.get("/balance", storeAuth, async (req, res) => {
  try {
    const result = await query(
      "SELECT balance, total_earned, total_spent FROM player_credits WHERE twitter_id = $1",
      [req.twitterId]
    );
    if (result.rows.length === 0) {
      return res.json({ balance: 0, total_earned: 0, total_spent: 0 });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("[Store] Balance error:", err.message);
    res.status(500).json({ error: "Failed to load balance" });
  }
});

// GET /api/store/transactions
// Recent transaction history
router.get("/transactions", storeAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const result = await query(
      `SELECT tx_type, amount, balance_after, ref_type, ref_id, note, created_at
       FROM credit_transactions
       WHERE twitter_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.twitterId, limit]
    );
    res.json({ transactions: result.rows });
  } catch (err) {
    console.error("[Store] Transactions error:", err.message);
    res.status(500).json({ error: "Failed to load transactions" });
  }
});

// ---------------------------------------------------------------
// Purchase
// ---------------------------------------------------------------

// POST /api/store/purchase
// Body: { slug: "skin-neon-pink" }
router.post("/purchase", storeAuth, async (req, res) => {
  // Rate limit check
  if (!checkPurchaseRate(req.twitterId)) {
    return res.status(429).json({ error: "Slow down, too many requests" });
  }

  const slug = String(req.body?.slug || "").slice(0, 64).replace(/[^a-z0-9_\-]/g, "");
  if (!slug) {
    return res.status(400).json({ error: "Missing item slug" });
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");

    // Lock the item row to prevent race conditions on supply
    const itemResult = await client.query(
      `SELECT id, slug, name, category, rarity, price_credits, is_default,
              available_from, available_until, max_supply, total_sold, active
       FROM store_items WHERE slug = $1 FOR UPDATE`,
      [slug]
    );

    if (itemResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
    }

    const item = itemResult.rows[0];

    // Validation checks
    if (!item.active) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Item no longer available" });
    }
    if (item.is_default) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "This item is free for everyone" });
    }
    if (item.locked) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "This item is not available for purchase yet" });
    }
    if (item.available_from && new Date(item.available_from) > new Date()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Item not yet available" });
    }
    if (item.available_until && new Date(item.available_until) <= new Date()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Item no longer available" });
    }
    if (item.max_supply !== null && item.total_sold >= item.max_supply) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Item sold out" });
    }

    // Check if player already owns this item
    const ownedCheck = await client.query(
      "SELECT id FROM player_inventory WHERE twitter_id = $1 AND item_id = $2",
      [req.twitterId, item.id]
    );
    if (ownedCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "You already own this item" });
    }

    // Ensure player_credits row exists, then lock and check balance
    await client.query(
      `INSERT INTO player_credits (twitter_id, balance) VALUES ($1, 0)
       ON CONFLICT (twitter_id) DO NOTHING`,
      [req.twitterId]
    );

    const balResult = await client.query(
      "SELECT balance FROM player_credits WHERE twitter_id = $1 FOR UPDATE",
      [req.twitterId]
    );

    const currentBalance = parseInt(balResult.rows[0].balance);
    if (currentBalance < item.price_credits) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Insufficient credits",
        balance: currentBalance,
        price: item.price_credits,
      });
    }

    // Deduct balance
    const newBalance = currentBalance - item.price_credits;
    await client.query(
      `UPDATE player_credits
       SET balance = $1, total_spent = total_spent + $2, updated_at = NOW()
       WHERE twitter_id = $3`,
      [newBalance, item.price_credits, req.twitterId]
    );

    // Add to inventory
    await client.query(
      "INSERT INTO player_inventory (twitter_id, item_id) VALUES ($1, $2)",
      [req.twitterId, item.id]
    );

    // Increment sold count
    await client.query(
      "UPDATE store_items SET total_sold = total_sold + 1 WHERE id = $1",
      [item.id]
    );

    // Log transaction
    await client.query(
      `INSERT INTO credit_transactions (twitter_id, tx_type, amount, balance_after, ref_type, ref_id, note)
       VALUES ($1, 'purchase', $2, $3, 'item_purchase', $4, $5)`,
      [req.twitterId, -item.price_credits, newBalance, item.slug, `Bought ${item.name}`]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      item: { slug: item.slug, name: item.name, category: item.category },
      balance: newBalance,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Store] Purchase error:", err.message);
    res.status(500).json({ error: "Purchase failed" });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------

// GET /api/store/inventory
// Returns all items the player owns (including defaults)
router.get("/inventory", storeAuth, async (req, res) => {
  try {
    const { category } = req.query;

    let categoryFilter = "";
    const params = [req.twitterId];

    if (category) {
      if (!VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: "Invalid category" });
      }
      categoryFilter = "AND si.category = $2";
      params.push(category);
    }

    // Owned items + all default items
    const result = await query(
      `SELECT si.id, si.slug, si.name, si.category, si.rarity, si.config, si.preview_url,
              si.is_default,
              CASE WHEN pi.id IS NOT NULL THEN true ELSE si.is_default END AS owned,
              pi.acquired_at
       FROM store_items si
       LEFT JOIN player_inventory pi ON pi.item_id = si.id AND pi.twitter_id = $1
       WHERE (pi.id IS NOT NULL OR si.is_default = true) AND si.active = true ${categoryFilter}
       ORDER BY si.category, si.rarity DESC, si.name`,
      params
    );

    res.json({ items: result.rows });
  } catch (err) {
    console.error("[Store] Inventory error:", err.message);
    res.status(500).json({ error: "Failed to load inventory" });
  }
});

// ---------------------------------------------------------------
// Loadout (equip/unequip)
// ---------------------------------------------------------------

// GET /api/store/loadout
// Returns the player's current equipped items
router.get("/loadout", storeAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT pl.*,
              sk.slug AS skin_slug, sk.config AS skin_config, sk.rarity AS skin_rarity,
              sc.slug AS skin_color_slug, sc.config AS skin_color_config,
              es.slug AS eye_style_slug, es.config AS eye_style_config,
              hw.slug AS headwear_slug, hw.config AS headwear_config,
              te.slug AS trail_effect_slug, te.config AS trail_effect_config,
              gc.slug AS glow_color_slug, gc.config AS glow_color_config,
              nc.slug AS name_color_slug, nc.config AS name_color_config,
              va.slug AS victory_anim_slug, va.config AS victory_anim_config,
              bd.slug AS badge_slug, bd.config AS badge_config
       FROM player_loadout pl
       LEFT JOIN store_items sk ON sk.id = pl.skin
       LEFT JOIN store_items sc ON sc.id = pl.skin_color
       LEFT JOIN store_items es ON es.id = pl.eye_style
       LEFT JOIN store_items hw ON hw.id = pl.headwear
       LEFT JOIN store_items te ON te.id = pl.trail_effect
       LEFT JOIN store_items gc ON gc.id = pl.glow_color
       LEFT JOIN store_items nc ON nc.id = pl.name_color
       LEFT JOIN store_items va ON va.id = pl.victory_anim
       LEFT JOIN store_items bd ON bd.id = pl.badge
       WHERE pl.twitter_id = $1`,
      [req.twitterId]
    );

    if (result.rows.length === 0) {
      return res.json({ loadout: null });
    }

    res.json({ loadout: result.rows[0] });
  } catch (err) {
    console.error("[Store] Loadout error:", err.message);
    res.status(500).json({ error: "Failed to load loadout" });
  }
});

// POST /api/store/equip
// Body: { slot: "skin_color", item_slug: "skin-neon-pink" }
// Pass item_slug = null to unequip a slot
router.post("/equip", storeAuth, async (req, res) => {
  const slot = String(req.body?.slot || "");
  if (!VALID_CATEGORIES.includes(slot)) {
    return res.status(400).json({ error: "Invalid slot", valid: VALID_CATEGORIES });
  }

  const itemSlug = req.body?.item_slug;

  try {
    // Unequip
    if (!itemSlug || itemSlug === null) {
      await query(
        `INSERT INTO player_loadout (twitter_id, ${slot})
         VALUES ($1, NULL)
         ON CONFLICT (twitter_id) DO UPDATE SET ${slot} = NULL, updated_at = NOW()`,
        [req.twitterId]
      );
      return res.json({ ok: true, slot, equipped: null });
    }

    const safeSlug = String(itemSlug).slice(0, 64).replace(/[^a-z0-9\_\-]/g, "");

    // Verify item exists, is the right category, and player owns it (or it's default)
    const itemResult = await query(
      `SELECT si.id, si.slug, si.category, si.config, si.is_default
       FROM store_items si
       LEFT JOIN player_inventory pi ON pi.item_id = si.id AND pi.twitter_id = $1
       WHERE si.slug = $2 AND si.active = true AND si.category = $3
         AND (pi.id IS NOT NULL OR si.is_default = true)`,
      [req.twitterId, safeSlug, slot]
    );

    if (itemResult.rows.length === 0) {
      return res.status(400).json({ error: "Item not found, wrong category, or not owned" });
    }

    const item = itemResult.rows[0];

    // Upsert loadout
    await query(
      `INSERT INTO player_loadout (twitter_id, ${slot})
       VALUES ($1, $2)
       ON CONFLICT (twitter_id) DO UPDATE SET ${slot} = $2, updated_at = NOW()`,
      [req.twitterId, item.id]
    );

    res.json({ ok: true, slot, equipped: { slug: item.slug, config: item.config } });
  } catch (err) {
    console.error("[Store] Equip error:", err.message);
    res.status(500).json({ error: "Equip failed" });
  }
});

// ---------------------------------------------------------------
// Admin auth helper (timing-safe, reusable)
// ---------------------------------------------------------------

async function verifyAdminKey(req) {
  const key = req.headers["x-admin-key"];
  if (!process.env.ADMIN_KEY || !key) return false;
  const expected = Buffer.from(process.env.ADMIN_KEY);
  const provided = Buffer.from(String(key).slice(0, 256));
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

// ---------------------------------------------------------------
// Admin: Credit Management (protected by admin key)
// ---------------------------------------------------------------

// POST /api/store/admin/credit
// Body: { twitter_id, amount, reason }
router.post("/admin/credit", async (req, res) => {
  if (!(await verifyAdminKey(req))) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { twitter_id, amount, reason } = req.body;
  if (!twitter_id || typeof amount !== "number" || amount === 0) {
    return res.status(400).json({ error: "Invalid params" });
  }

  const safeId = String(twitter_id).slice(0, 32);
  const safeAmount = Math.floor(amount);
  const safeReason = String(reason || "Admin adjustment").slice(0, 256);

  const client = await getClient();
  try {
    await client.query("BEGIN");

    await client.query(
      "INSERT INTO player_credits (twitter_id, balance) VALUES ($1, 0) ON CONFLICT (twitter_id) DO NOTHING",
      [safeId]
    );

    const balResult = await client.query(
      "SELECT balance FROM player_credits WHERE twitter_id = $1 FOR UPDATE",
      [safeId]
    );

    const current = parseInt(balResult.rows[0].balance);
    const newBalance = current + safeAmount;

    if (newBalance < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Would result in negative balance" });
    }

    const earnedDelta = safeAmount > 0 ? safeAmount : 0;
    const spentDelta = safeAmount < 0 ? Math.abs(safeAmount) : 0;

    await client.query(
      `UPDATE player_credits
       SET balance = $1, total_earned = total_earned + $2, total_spent = total_spent + $3, updated_at = NOW()
       WHERE twitter_id = $4`,
      [newBalance, earnedDelta, spentDelta, safeId]
    );

    await client.query(
      `INSERT INTO credit_transactions (twitter_id, tx_type, amount, balance_after, ref_type, ref_id, note)
       VALUES ($1, 'admin', $2, $3, 'admin_adjustment', $4, $5)`,
      [safeId, safeAmount, newBalance, `admin_${Date.now()}`, safeReason]
    );

    await client.query("COMMIT");
    res.json({ ok: true, twitter_id: safeId, balance: newBalance });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Store] Admin credit error:", err.message);
    res.status(500).json({ error: "Credit adjustment failed" });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------
// Admin: Item CRUD
// ---------------------------------------------------------------

// GET /api/store/admin/items -- list all items (including inactive)
router.get("/admin/items", async (req, res) => {
  if (!(await verifyAdminKey(req))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const result = await query(
      `SELECT * FROM store_items ORDER BY category, rarity DESC, created_at DESC`
    );
    res.json({ items: result.rows });
  } catch (err) {
    console.error("[Store] Admin list error:", err.message);
    res.status(500).json({ error: "Failed to list items" });
  }
});

// POST /api/store/admin/items -- create a new item
router.post("/admin/items", async (req, res) => {
  if (!(await verifyAdminKey(req))) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { slug, name, description, category, rarity, price_credits, config,
          traits, preview_url, is_default, locked, available_from, available_until, max_supply } = req.body;

  // Validate required fields
  if (!slug || !name || !category) {
    return res.status(400).json({ error: "slug, name, and category are required" });
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: "Invalid category", valid: VALID_CATEGORIES });
  }
  if (rarity && !VALID_RARITIES.includes(rarity)) {
    return res.status(400).json({ error: "Invalid rarity", valid: VALID_RARITIES });
  }

  const safeSlug = String(slug).slice(0, 64).toLowerCase().replace(/[^a-z0-9\_\-]/g, "");
  const safeName = String(name).slice(0, 64);
  const safeDesc = description ? String(description).slice(0, 256) : null;
  const safePrice = Math.max(0, Math.floor(price_credits || 0));
  const safeConfig = config && typeof config === "object" ? config : {};
  const safeTraits = Array.isArray(traits) ? traits : [];

  try {
    const result = await query(
      `INSERT INTO store_items (slug, name, description, category, rarity, price_credits, config,
                                traits, preview_url, is_default, locked, available_from, available_until, max_supply, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true)
       ON CONFLICT (slug) DO UPDATE SET
         name=EXCLUDED.name,
         description=EXCLUDED.description,
         category=EXCLUDED.category,
         rarity=EXCLUDED.rarity,
         price_credits=EXCLUDED.price_credits,
         config=EXCLUDED.config,
         traits=EXCLUDED.traits,
         preview_url=EXCLUDED.preview_url,
         is_default=EXCLUDED.is_default,
         locked=EXCLUDED.locked,
         available_from=EXCLUDED.available_from,
         available_until=EXCLUDED.available_until,
         max_supply=EXCLUDED.max_supply,
         active=true
       RETURNING *`,
      [safeSlug, safeName, safeDesc, category, rarity || "common", safePrice,
       JSON.stringify(safeConfig), JSON.stringify(safeTraits), preview_url || null,
       is_default || false, locked || false,
       available_from || null, available_until || null, max_supply || null]
    );
    res.json({ ok: true, item: result.rows[0] });
  } catch (err) {
    console.error("[Store] Admin create error:", err.message);
    res.status(500).json({ error: "Failed to create item" });
  }
});

// PUT /api/store/admin/items/:id -- update an item
router.put("/admin/items/:id", async (req, res) => {
  if (!(await verifyAdminKey(req))) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid item ID" });

  const fields = [];
  const values = [];
  let idx = 1;

  const allowedFields = {
    name: { max: 64, type: "string" },
    description: { max: 256, type: "string" },
    category: { type: "enum", valid: VALID_CATEGORIES },
    rarity: { type: "enum", valid: VALID_RARITIES },
    price_credits: { type: "int", min: 0 },
    config: { type: "json" },
    traits: { type: "json" },
    preview_url: { max: 256, type: "string" },
    is_default: { type: "boolean" },
    locked: { type: "boolean" },
    available_from: { type: "timestamp" },
    available_until: { type: "timestamp" },
    max_supply: { type: "int_nullable" },
    active: { type: "boolean" },
  };

  for (const [key, rules] of Object.entries(allowedFields)) {
    if (req.body[key] === undefined) continue;
    let val = req.body[key];

    if (rules.type === "string") {
      val = val === null ? null : String(val).slice(0, rules.max);
    } else if (rules.type === "enum") {
      if (!rules.valid.includes(val)) {
        return res.status(400).json({ error: `Invalid ${key}`, valid: rules.valid });
      }
    } else if (rules.type === "int") {
      val = Math.max(rules.min || 0, Math.floor(Number(val) || 0));
    } else if (rules.type === "int_nullable") {
      val = val === null ? null : Math.max(0, Math.floor(Number(val) || 0));
    } else if (rules.type === "boolean") {
      val = Boolean(val);
    } else if (rules.type === "json") {
      val = typeof val === "object" ? JSON.stringify(val) : "{}";
    } else if (rules.type === "timestamp") {
      val = val === null ? null : new Date(val).toISOString();
    }

    fields.push(`${key} = $${idx++}`);
    values.push(val);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  values.push(id);

  try {
    const result = await query(
      `UPDATE store_items SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.json({ ok: true, item: result.rows[0] });
  } catch (err) {
    console.error("[Store] Admin update error:", err.message);
    res.status(500).json({ error: "Failed to update item" });
  }
});

// DELETE /api/store/admin/items/:id -- soft-delete (deactivate)
router.delete("/admin/items/:id", async (req, res) => {
  if (!(await verifyAdminKey(req))) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid item ID" });

  try {
    const result = await query(
      "UPDATE store_items SET active = false WHERE id = $1 RETURNING id, slug, name",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.json({ ok: true, deactivated: result.rows[0] });
  } catch (err) {
    console.error("[Store] Admin delete error:", err.message);
    res.status(500).json({ error: "Failed to deactivate item" });
  }
});

// DELETE /api/store/admin/items/:id/hard -- permanent delete
// Safe-by-default: refuses if any player owns the item or has it equipped.
// Prefer soft-delete in almost all cases; this is only for clearing out
// mis-forged rows that nobody has interacted with.
router.delete("/admin/items/:id/hard", async (req, res) => {
  if (!(await verifyAdminKey(req))) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid item ID" });

  const client = await getClient();
  try {
    await client.query("BEGIN");

    // Refuse if any player owns this item
    const invCheck = await client.query(
      "SELECT COUNT(*)::int AS n FROM player_inventory WHERE item_id = $1",
      [id]
    );
    if (invCheck.rows[0].n > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Cannot hard-delete: " + invCheck.rows[0].n + " player(s) own this item. Use soft-delete instead.",
      });
    }

    // Clear any loadout references (safe to null them)
    await client.query(
      `UPDATE player_loadout SET
         skin = CASE WHEN skin = $1 THEN NULL ELSE skin END,
         skin_color = CASE WHEN skin_color = $1 THEN NULL ELSE skin_color END,
         eye_style = CASE WHEN eye_style = $1 THEN NULL ELSE eye_style END,
         headwear = CASE WHEN headwear = $1 THEN NULL ELSE headwear END,
         trail_effect = CASE WHEN trail_effect = $1 THEN NULL ELSE trail_effect END,
         glow_color = CASE WHEN glow_color = $1 THEN NULL ELSE glow_color END,
         name_color = CASE WHEN name_color = $1 THEN NULL ELSE name_color END,
         victory_anim = CASE WHEN victory_anim = $1 THEN NULL ELSE victory_anim END,
         badge = CASE WHEN badge = $1 THEN NULL ELSE badge END`,
      [id]
    );

    const result = await client.query(
      "DELETE FROM store_items WHERE id = $1 RETURNING id, slug, name",
      [id]
    );
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
    }

    await client.query("COMMIT");
    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Store] Admin hard-delete error:", err.message);
    res.status(500).json({ error: "Failed to delete item" });
  } finally {
    client.release();
  }
});

// GET /api/store/admin/stats -- store-wide stats
router.get("/admin/stats", async (req, res) => {
  if (!(await verifyAdminKey(req))) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const [itemStats, creditStats, recentTx] = await Promise.all([
      query(`SELECT
               COUNT(*) AS total_items,
               COUNT(*) FILTER (WHERE active) AS active_items,
               SUM(total_sold) AS total_sales,
               COUNT(*) FILTER (WHERE max_supply IS NOT NULL AND total_sold >= max_supply) AS sold_out
             FROM store_items`),
      query(`SELECT
               COUNT(*) AS total_players,
               SUM(balance) AS total_credits_circulating,
               SUM(total_spent) AS total_credits_spent
             FROM player_credits`),
      query(`SELECT twitter_id, tx_type, amount, ref_id, note, created_at
             FROM credit_transactions ORDER BY created_at DESC LIMIT 20`),
    ]);

    res.json({
      items: itemStats.rows[0],
      credits: creditStats.rows[0],
      recent_transactions: recentTx.rows,
    });
  } catch (err) {
    console.error("[Store] Admin stats error:", err.message);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

// GET /api/store/admin/players -- list players with balances
router.get("/admin/players", async (req, res) => {
  if (!(await verifyAdminKey(req))) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const result = await query(
      `SELECT pc.twitter_id, tp.username, pc.balance, pc.total_earned, pc.total_spent, pc.updated_at,
              (SELECT COUNT(*) FROM player_inventory pi WHERE pi.twitter_id = pc.twitter_id) AS items_owned
       FROM player_credits pc
       LEFT JOIN twitter_profiles tp ON tp.twitter_id = pc.twitter_id
       ORDER BY pc.balance DESC
       LIMIT 100`
    );
    res.json({ players: result.rows });
  } catch (err) {
    console.error("[Store] Admin players error:", err.message);
    res.status(500).json({ error: "Failed to load players" });
  }
});

// ---------------------------------------------------------------
// Game Rewards Hook
// Called by game server when a player earns credits from gameplay
// ---------------------------------------------------------------

export async function awardGameCredits(twitterId, amount, reason) {
  if (!twitterId || !amount || amount <= 0) return null;

  const safeId = String(twitterId).slice(0, 32);
  const safeAmount = Math.floor(amount);

  const client = await getClient();
  try {
    await client.query("BEGIN");

    await client.query(
      "INSERT INTO player_credits (twitter_id, balance) VALUES ($1, 0) ON CONFLICT (twitter_id) DO NOTHING",
      [safeId]
    );

    const balResult = await client.query(
      "SELECT balance FROM player_credits WHERE twitter_id = $1 FOR UPDATE",
      [safeId]
    );

    const newBalance = parseInt(balResult.rows[0].balance) + safeAmount;

    await client.query(
      `UPDATE player_credits
       SET balance = $1, total_earned = total_earned + $2, updated_at = NOW()
       WHERE twitter_id = $3`,
      [newBalance, safeAmount, safeId]
    );

    await client.query(
      `INSERT INTO credit_transactions (twitter_id, tx_type, amount, balance_after, ref_type, ref_id, note)
       VALUES ($1, 'reward', $2, $3, 'game_reward', $4, $5)`,
      [safeId, safeAmount, newBalance, `reward_${Date.now()}`, String(reason || "Game reward").slice(0, 256)]
    );

    await client.query("COMMIT");
    return newBalance;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Store] Award credits error:", err.message);
    return null;
  } finally {
    client.release();
  }
}

export default router;
