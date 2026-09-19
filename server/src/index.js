import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { Server as SocketIO } from "socket.io";
import cors from "cors";
import helmet from "helmet";

import apiRoutes from "./routes/api.js";
import betaRoutes from "./routes/beta.js";
import trackRoutes from "./routes/track.js";
import metricsRoutes from "./routes/metrics.js";
import { initDb } from "./db/pool.js";
import { initContracts } from "./services/contractService.js";
import { initGameSocket } from "./ws/gameSocket.js";
import { setupTwitterAuth } from "./utils/twitterAuth.js";

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

// Hostname-based routing: play.hoppingheads.fun serves game, root serves landing
app.use((req, res, next) => {
  const host = req.hostname;
  if (host === 'play.hoppingheads.fun') {
    req.isPlaySubdomain = true;
  }
  next();
});

// Server-side playtest gate for play subdomain and /play route
const PLAYTEST_GATE_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hopping Heads</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0614;color:#e8e4f0;font-family:monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
.g{font-size:14px;color:#8a80b0}.g a{color:#ffd54f;text-decoration:none}</style></head><body>
<div><div class="g">CHECKING ACCESS...</div></div>
<script>
(function(){
  // Check URL for session (cross-subdomain handoff)
  var url=new URL(window.location.href);
  var urlSession=url.searchParams.get('session');
  if(urlSession){
    localStorage.setItem('hh_session',urlSession);
    // Clean URL
    history.replaceState(null,'',window.location.pathname);
  }
  var s=localStorage.getItem('hh_session');
  if(!s){window.location.href='https://hoppingheads.fun#playtest';return}
  fetch('/api/beta/check?session='+encodeURIComponent(s))
    .then(function(r){return r.json()})
    .then(function(d){
      if(d.access){window.location.href='/game?session='+encodeURIComponent(s)}
      else{window.location.href='https://hoppingheads.fun#playtest'}
    })
    .catch(function(){window.location.href='https://hoppingheads.fun#playtest'});
})();
</script></body></html>`;

// Root route: landing page, gate, or game
app.get('/', (req, res, next) => {
  if (req.isPlaySubdomain) {
    return res.type('html').send(PLAYTEST_GATE_HTML);
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

// Actual game served at /game (behind gate)
app.use("/game", express.static(path.join(__dirname, "..", "public")));

// Serve landing page at root domain
app.use(express.static(path.join(__dirname, "..", "landing")));
// /play also goes through gate
app.get("/play", (req, res) => {
  res.type('html').send(PLAYTEST_GATE_HTML);
});
app.use("/play", express.static(path.join(__dirname, "..", "public")));
// Also serve public assets on play subdomain root
app.use((req, res, next) => {
  if (req.isPlaySubdomain) {
    return express.static(path.join(__dirname, '..', 'public'))(req, res, next);
  }
  next();
});

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

// Twitter/X OAuth
setupTwitterAuth(app);

// Playtest API routes
app.use("/api/beta", betaRoutes);
app.use("/api/track", trackRoutes);
app.use("/api/metrics", metricsRoutes);

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

  try {
    initContracts();
    console.log("[Boot] Contracts ready");
  } catch (err) {
    console.warn("[Boot] Contract init failed:", err.message);
    console.warn("[Boot] Running in offline mode");
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
