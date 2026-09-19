import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { Server as SocketIO } from "socket.io";
import cors from "cors";
import helmet from "helmet";

import apiRoutes from "./routes/api.js";
import { initDb } from "./db/pool.js";
import { initGameSocket } from "./ws/gameSocket.js";
import { walletAuthRoutes } from "./utils/walletAuth.js";

import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5173,https://hoppingheads.fun,https://play.hoppingheads.fun")
  .split(",")
  .map((s) => s.trim());

// -- Express setup --------------------------------------------

const app = express();
app.set('trust proxy', 1); // Railway runs behind reverse proxy
const server = http.createServer(app);

app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled for inline scripts in game client
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// Healthcheck -- Railway hits this. Must be registered BEFORE the HTTPS
// redirect middleware so health pings don't get 301'd and counted as failures.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Force HTTPS in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, `https://${req.hostname}${req.originalUrl}`);
  }
  next();
});

// Legal pages - BEFORE static middleware
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landing', 'terms.html'));
});
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landing', 'privacy.html'));
});

// Game client
app.use("/game", express.static(path.join(__dirname, "..", "public")));

// Serve landing page at root domain
app.use(express.static(path.join(__dirname, "..", "landing")));

// Rate limiting (basic -- use a proper limiter in production)
const requestCounts = new Map();
app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const entry = requestCounts.get(ip) || { count: 0, resetAt: now + 60000 };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 60000;
  }

  entry.count++;
  requestCounts.set(ip, entry);

  if (entry.count > 120) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  }

  next();
});

// Wallet sign in
app.use("/auth", walletAuthRoutes);


// API routes
app.use("/api", apiRoutes);

// Clean up rate limiter entries every 5 min
setInterval(()=>{const now=Date.now();for(const[ip,e]of requestCounts){if(now>e.resetAt+120000)requestCounts.delete(ip)}},300000);

// -- Socket.io setup ------------------------------------------

const io = new SocketIO(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
  },
  pingInterval: 10000,
  pingTimeout: 5000,
  maxHttpBufferSize: 1e5, // 100KB max message
});

// Connection rate limiting
const socketConnections = new Map();
io.use((socket, next) => {
  const ip = socket.handshake.address;
  const now = Date.now();
  const entry = socketConnections.get(ip) || { count: 0, resetAt: now + 60000 };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 60000;
  }

  entry.count++;
  socketConnections.set(ip, entry);

  if (entry.count > 10) {
    return next(new Error("Too many connections"));
  }

  next();
});

initGameSocket(io);

// -- Boot -----------------------------------------------------

async function boot() {
  try {
    await initDb();
    console.log("[Boot] Database ready");
  } catch (err) {
    console.error("[Boot] Database init failed:", err.message);
    console.warn("[Boot] Continuing without database (dev mode)");
  }

  server.listen(PORT, () => {
    console.log(`\n  HOPPING HEADS SERVER`);
    console.log(`  Port:    ${PORT}`);
    console.log(`  Env:     ${process.env.NODE_ENV || "development"}`);
    console.log(`  Origins: ${ALLOWED_ORIGINS.join(", ")}`);
    console.log();
  });
}

boot();

export { app, io, server };
