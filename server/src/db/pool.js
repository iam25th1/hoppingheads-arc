import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

export async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 200) {
      console.warn(`[DB] Slow query (${duration}ms):`, text.slice(0, 80));
    }
    return res;
  } catch (err) {
    // Retry once on connection reset/timeout
    if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.message.includes('ETIMEDOUT') || err.message.includes('Connection terminated')) {
      console.warn('[DB] Connection lost, retrying query...');
      const res = await pool.query(text, params);
      const duration = Date.now() - start;
      if (duration > 200) console.warn(`[DB] Slow retry (${duration}ms):`, text.slice(0, 80));
      return res;
    }
    throw err;
  }
}

export async function getClient() {
  return pool.connect();
}

export async function initDb() {
  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  await pool.query(schema);
  console.log("[DB] Schema initialized");
}

export default pool;
