/**
 * Quick-Match Game Socket - Hardened v2
 * Security: input validation, rate limiting, anti-cheat, XSS prevention
 */

import { query } from "../db/pool.js";

const TICK_RATE = 100;
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const ROUND_DURATION = 180;
const LOBBY_WAIT_TIME = 30; // seconds to wait before starting with fewer than 8
const MAP_HALF = 150; // MAP/2
const MAX_SPEED = 25; // units per tick (SPD=18 * 2x speed boost * margin)

// Allowed skin values (whitelist)
const VALID_SKINS = [0xff8866,0xaadd55,0xaa88dd,0x88bbcc,0xddcc55,0xff99bb,0x66ccaa,0xffaa55,
  // Premium store skins
  0xff44aa,0x2244aa,0x33ff33,0xff3311,0xddeeff,0x1a1a2e,0xff88cc,0xaa5533,0x8866cc,0xffffff];
const VALID_EYES = ['X','Dots','Slit','Open',
  // Premium store eyes
  'Heart','Star','Spiral','Laser','Void','Diamond'];
const VALID_HEADS = ['Horns','Crown','Antenna','Spike','Ears',
  // Premium store headwear
  'Halo','TopHat','Beanie','Mohawk','Propeller','Mushroom','FlameCrown'];
const DEFAULT_SKINS = [
  {skinColor:0xff8866,eyeStyle:'X',headStyle:'Horns'},
  {skinColor:0xaadd55,eyeStyle:'Dots',headStyle:'Crown'},
  {skinColor:0xaa88dd,eyeStyle:'Slit',headStyle:'Antenna'},
  {skinColor:0x88bbcc,eyeStyle:'Open',headStyle:'Spike'},
  {skinColor:0xddcc55,eyeStyle:'X',headStyle:'Ears'},
];

// Rate limiter per socket
function createRateLimiter(maxPerSec) {
  let tokens = maxPerSec;
  let lastRefill = Date.now();
  return function check() {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    tokens = Math.min(maxPerSec, tokens + elapsed * maxPerSec);
    lastRefill = now;
    if (tokens < 1) return false;
    tokens--;
    return true;
  };
}

// Sanitize string: strip HTML, control chars, trim
function sanitize(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'&\/\\]/g, '').replace(/[\x00-\x1f]/g, '').trim().slice(0, maxLen);
}

// Validate number within range
function clampNum(val, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, n));
}

const lobbies = new Map();
let nextLobbyId = 1;

function createLobby() {
  const id = nextLobbyId++;
  const lobby = {
    id, status:'waiting', players:new Map(),
    mapIndex: Math.floor(Math.random() * 6),
    mapSeed: Math.random().toString(36).slice(2, 10),
    startTime:null, endTime:null,
    tickInterval:null, countdownInterval:null, autoStartTimer:null,
    waitStartedAt:null, waitTickInterval:null,
    createdAt:Date.now(),
  };
  lobbies.set(id, lobby);
  return lobby;
}

function findOpenLobby() {
  for (const [id, lobby] of lobbies) {
    if (lobby.status === 'waiting' && lobby.players.size < MAX_PLAYERS) return lobby;
  }
  return null;
}

import crypto from "crypto";
const TWITTER_CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET;

// Verify Twitter session signature (mirrors twitterAuth.js)
function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  if (!TWITTER_CLIENT_SECRET) return null;
  try {
    const [session, sig] = token.split('.');
    if (!session || !sig) return null;
    const expected = crypto.createHmac('sha256', TWITTER_CLIENT_SECRET)
      .update(session).digest('base64url');
    if (sig !== expected) return null;
    const data = JSON.parse(Buffer.from(session, 'base64url').toString());
    // Sessions older than 7 days are rejected
    if (Date.now() - data.ts > 7 * 24 * 60 * 60 * 1000) return null;
    return data;
  } catch {
    return null;
  }
}

// Check playtest access in DB
async function hasPlaytestAccess(twitterId) {
  if (!twitterId) return false;
  try {
    const r = await query('SELECT 1 FROM beta_access WHERE twitter_id = $1 LIMIT 1', [twitterId]);
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

export function initGameSocket(io) {
  io.on('connection', (socket) => {
    let playerId = null;
    let currentLobby = null;
    let hasJoined = false;
    let verifiedUser = null; // Twitter user from session

    // Per-event rate limiters
    const posLimiter = createRateLimiter(15);  // 15 pos updates/sec max
    const fragLimiter = createRateLimiter(3);  // 3 frag collects/sec max
    const mintLimiter = createRateLimiter(1);  // 1 mint/sec max
    const boinkLimiter = createRateLimiter(2); // 2 boinks/sec max

    socket.on('quickmatch', async ({ name, skin, session }) => {
      // Prevent double-join
      if (hasJoined) return;

      // PLAYTEST GATE: verify Twitter session and playtest access
      const user = verifySession(session);
      if (!user) {
        socket.emit('auth:denied', { reason: 'Invalid session. Connect X first.' });
        return;
      }
      const access = await hasPlaytestAccess(user.id);
      if (!access) {
        socket.emit('auth:denied', { reason: 'Playtest access required.' });
        return;
      }
      verifiedUser = user;
      hasJoined = true;

      // Use Twitter username as canonical name (ignore client-supplied name)
      const pName = sanitize(user.username, 12) || 'Player';
      playerId = socket.id.slice(0, 8);

      let lobby = findOpenLobby();
      if (!lobby) lobby = createLobby();

      const playerIndex = lobby.players.size;

      // Validate skin against whitelist
      let appearance;
      const cosmeticExtras = {};

      if (!appearance) {
        if (skin && VALID_SKINS.includes(skin.skinColor) &&
            VALID_EYES.includes(skin.eyeStyle) &&
            VALID_HEADS.includes(skin.headStyle)) {
          appearance = { skinColor: skin.skinColor, eyeStyle: skin.eyeStyle, headStyle: skin.headStyle };
        } else {
          appearance = DEFAULT_SKINS[playerIndex % DEFAULT_SKINS.length];
        }
      }

      lobby.players.set(playerId, {
        id: playerId, socketId: socket.id, name: pName,
        twitterId: user.id,
        x:0, y:0, z:0, ry:0, score:0,
        fragments:[0,0,0,0,0], minted:0, moving:false,
        appearance, cosmeticExtras, index: playerIndex,
        lastPosTime: Date.now(), lastX:0, lastZ:0,
        fragCount:0, maxFrags:48, shadow:0,
        maxMints:5, boinkCd:0,
      });

      currentLobby = lobby;
      socket.join(`lobby:${lobby.id}`);

      socket.emit('joined', {
        playerId, lobbyId: lobby.id,
        mapSeed: lobby.mapSeed, mapIndex: lobby.mapIndex,
        appearance, cosmeticExtras,
        players: Array.from(lobby.players.values()).map(p => ({
          id:p.id, name:p.name, appearance:p.appearance, extras:p.cosmeticExtras,
        })),
      });

      socket.to(`lobby:${lobby.id}`).emit('player:joined', {
        id:playerId, name:pName, appearance, extras:cosmeticExtras, count:lobby.players.size,
      });

      console.log(`[MP] ${pName} joined lobby ${lobby.id} (${lobby.players.size}/${MAX_PLAYERS})`);

      // Full lobby: start immediately
      if (lobby.players.size >= MAX_PLAYERS && lobby.status === 'waiting') {
        if (lobby.waitTickInterval) { clearInterval(lobby.waitTickInterval); lobby.waitTickInterval = null; }
        if (lobby.autoStartTimer) { clearTimeout(lobby.autoStartTimer); lobby.autoStartTimer = null; }
        io.to(`lobby:${lobby.id}`).emit('lobby:full');
        beginCountdown(io, lobby);
      }
      // First 2+ players: start 2-min wait countdown
      else if (lobby.players.size >= MIN_PLAYERS && !lobby.waitStartedAt && lobby.status === 'waiting') {
        lobby.waitStartedAt = Date.now();
        io.to(`lobby:${lobby.id}`).emit('auto:starting', { seconds: LOBBY_WAIT_TIME });

        // Tick every second to update clients with remaining wait time
        lobby.waitTickInterval = setInterval(() => {
          if (lobby.status !== 'waiting') { clearInterval(lobby.waitTickInterval); return; }
          const elapsed = Math.floor((Date.now() - lobby.waitStartedAt) / 1000);
          const remaining = Math.max(0, LOBBY_WAIT_TIME - elapsed);
          io.to(`lobby:${lobby.id}`).emit('lobby:wait', { seconds: remaining, players: lobby.players.size, max: MAX_PLAYERS });
          if (remaining <= 0) {
            clearInterval(lobby.waitTickInterval);
            lobby.waitTickInterval = null;
            beginCountdown(io, lobby);
          }
        }, 1000);
      }
    });

    socket.on('pos', ({ x, y, z, ry, moving, fc, sh }) => {
      if (!currentLobby || !playerId) return;
      if (!posLimiter()) return; // rate limit

      const p = currentLobby.players.get(playerId);
      if (!p) return;

      // Validate and clamp all values
      const nx = clampNum(x, -MAP_HALF, MAP_HALF);
      const nz = clampNum(z, -MAP_HALF, MAP_HALF);
      const nry = clampNum(ry, -Math.PI * 2, Math.PI * 2);

      // Track fragment count for grow system (clamped to sane range)
      if (typeof fc === 'number' && Number.isFinite(fc)) {
        p.fragCount = Math.max(0, Math.min(p.maxFrags, Math.floor(fc)));
      }

      // Track shadow state (0 or 1)
      p.shadow = (sh === 1) ? 1 : 0;

      // Anti-teleport: adjust max speed based on grow (more frags = slower)
      const growFactor = Math.min(1, (p.fragCount * 0.022) / 1.2); // mirrors client GROW_PER_FRAG
      const adjustedMaxSpeed = MAX_SPEED * (1 - growFactor * 0.45); // mirrors SPEED_PENALTY_MAX

      const dx = nx - p.lastX;
      const dz = nz - p.lastZ;
      const dist = Math.sqrt(dx*dx + dz*dz);
      const now = Date.now();
      const elapsed = Math.max(now - p.lastPosTime, 16) / 1000;
      const maxDist = adjustedMaxSpeed * elapsed + 2; // +2 margin for knockback

      if (dist > maxDist && p.lastPosTime > 0) {
        // Suspicious movement, clamp
        const ratio = maxDist / dist;
        p.x = p.lastX + dx * ratio;
        p.z = p.lastZ + dz * ratio;
      } else {
        p.x = nx;
        p.z = nz;
      }

      p.y = 0; // Y is always 0 (flat ground - LOCKED)
      p.ry = nry;
      p.moving = !!moving;
      p.lastX = p.x;
      p.lastZ = p.z;
      p.lastPosTime = now;
    });

    socket.on('frag:collected', ({ rarity, score }) => {
      if (!currentLobby || !playerId) return;
      if (!fragLimiter()) return;

      const p = currentLobby.players.get(playerId);
      if (!p) return;

      // Validate rarity
      const r = clampNum(rarity, 0, 4);
      if (r !== Math.floor(r)) return;

      // Cap fragment count (can't collect more than exist on map)
      if (p.fragCount >= p.maxFrags) return;
      p.fragments[r]++;
      p.fragCount++;

      // Server calculates score, don't trust client
      const PTS = [3, 3, 3, 3, 3]; // all frags worth 3 pts
      p.score += PTS[r];

      socket.to(`lobby:${currentLobby.id}`).emit('frag:taken', { id:playerId, rarity:r, score:p.score });
    });

    socket.on('mint:done', ({ rarity, score }) => {
      if (!currentLobby || !playerId) return;
      if (!mintLimiter()) return;

      const p = currentLobby.players.get(playerId);
      if (!p) return;

      // Cap mints
      if (p.minted >= p.maxMints) return;

      const r = clampNum(rarity, 0, 4);
      if (r !== Math.floor(r)) return;

      p.minted++;
      // Server calculates mint score
      const MINT_PTS = [10, 25, 50, 100, 250];
      p.score += MINT_PTS[r];

      io.to(`lobby:${currentLobby.id}`).emit('mint:broadcast', { id:playerId, rarity:r, minted:p.minted, score:p.score });
    });

    socket.on('boink', ({ target, myFrags }) => {
      if (!currentLobby || !playerId) return;
      if (!boinkLimiter()) return;

      // Validate target exists
      if (typeof target !== 'string') return;
      const targetPlayer = currentLobby.players.get(target);
      if (!targetPlayer) return;

      // Validate proximity (can't boink across the map)
      const p = currentLobby.players.get(playerId);
      if (!p) return;

      // Can't boink a player in shadow form
      if (targetPlayer.shadow === 1) return;
      const dx = p.x - targetPlayer.x;
      const dz = p.z - targetPlayer.z;
      // Boink range scales with attacker size (mirrors client calcBoinkRange)
      const attackerScale = 1.0 + Math.min(1.2, (p.fragCount || 0) * 0.022);
      const boinkRange = 5 * attackerScale; // base 5 on server (slightly generous for latency)
      if (Math.sqrt(dx*dx + dz*dz) > boinkRange) return;

      // Validate and clamp attacker frag count (use server-tracked value, don't trust client)
      const attackerFrags = p.fragCount || 0;

      const targetSocket = io.sockets.sockets.get(targetPlayer.socketId);
      if (targetSocket) targetSocket.emit('boink:hit', { from: playerId, attackerFrags });
    });

    socket.on('disconnect', () => {
      if (!currentLobby || !playerId) return;
      currentLobby.players.delete(playerId);
      io.to(`lobby:${currentLobby.id}`).emit('player:left', { id:playerId, count:currentLobby.players.size });

      if (currentLobby.players.size < MIN_PLAYERS && currentLobby.autoStartTimer && currentLobby.status === 'waiting') {
        clearTimeout(currentLobby.autoStartTimer);
        currentLobby.autoStartTimer = null;
        io.to(`lobby:${currentLobby.id}`).emit('auto:cancelled');
      }

      if (currentLobby.players.size === 0) {
        if (currentLobby.tickInterval) clearInterval(currentLobby.tickInterval);
        if (currentLobby.countdownInterval) clearInterval(currentLobby.countdownInterval);
        if (currentLobby.autoStartTimer) clearTimeout(currentLobby.autoStartTimer);
        lobbies.delete(currentLobby.id);
      }
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [id, lobby] of lobbies) {
      if (lobby.status === 'waiting' && now - lobby.createdAt > 120000 && lobby.players.size === 0) {
        lobbies.delete(id);
      }
    }
  }, 60000);
}

function beginCountdown(io, lobby) {
  lobby.status = 'countdown';
  if (lobby.waitTickInterval) { clearInterval(lobby.waitTickInterval); lobby.waitTickInterval = null; }
  let count = 3;
  io.to(`lobby:${lobby.id}`).emit('countdown', { count });
  lobby.countdownInterval = setInterval(() => {
    count--;
    if (count > 0) {
      io.to(`lobby:${lobby.id}`).emit('countdown', { count });
    } else {
      clearInterval(lobby.countdownInterval);
      startRound(io, lobby);
    }
  }, 1000);
}

function startRound(io, lobby) {
  lobby.status = 'active';
  lobby.startTime = Date.now();
  lobby.endTime = lobby.startTime + ROUND_DURATION * 1000;

  io.to(`lobby:${lobby.id}`).emit('round:start', {
    duration:ROUND_DURATION, endTime:lobby.endTime,
    mapSeed:lobby.mapSeed, mapIndex:lobby.mapIndex,
  });

  console.log(`[MP] Round started lobby ${lobby.id} (${lobby.players.size} players)`);

  lobby.tickInterval = setInterval(() => {
    if (lobby.status !== 'active') { clearInterval(lobby.tickInterval); return; }

    const timeLeft = Math.max(0, lobby.endTime - Date.now());
    const players = [];
    for (const [id, p] of lobby.players) {
      players.push({
        id:p.id, n:sanitize(p.name, 12),
        x:Math.round(p.x*10)/10, y:0,
        z:Math.round(p.z*10)/10, ry:Math.round(p.ry*100)/100,
        m:p.moving?1:0, s:p.score, mt:p.minted,
        sk:p.appearance.skinColor,
        ey:p.appearance.eyeStyle,
        hw:p.appearance.headStyle,
        fc:p.fragCount||0, // fragment count for grow system
        sh:p.shadow||0,    // shadow form active
      });
    }

    io.to(`lobby:${lobby.id}`).emit('tick', { t:Math.ceil(timeLeft/1000), p:players });

    if (timeLeft <= 0) {
      clearInterval(lobby.tickInterval);
      endRound(io, lobby);
    }
  }, TICK_RATE);
}

function endRound(io, lobby) {
  lobby.status = 'ended';
  const results = Array.from(lobby.players.values())
    .map(p => ({ id:p.id, name:sanitize(p.name, 12), score:p.score, minted:p.minted,
      fragments:p.fragments.reduce((a,b)=>a+b,0), twitterId:p.twitterId }))
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ ...r, placement:i+1 }));

  // Emit results without twitterId (don't leak to other players)
  io.to(`lobby:${lobby.id}`).emit('round:end', { results: results.map(r => ({
    id:r.id, name:r.name, score:r.score, minted:r.minted, fragments:r.fragments, placement:r.placement
  }))});
  console.log(`[MP] Round ended lobby ${lobby.id}. Winner: ${results[0]?.name} (${results[0]?.score})`);

  saveResults(results, lobby.mapIndex).catch(e => console.error('[MP] Save error:', e.message));
  setTimeout(() => lobbies.delete(lobby.id), 30000);
}

async function saveResults(results, mapIndex) {
  for (const r of results) {
    const safeName = sanitize(r.name, 12) || 'Unknown';
    await query(
      `INSERT INTO leaderboard (player_name, score, minted, fragments, placement, map_index) VALUES ($1,$2,$3,$4,$5,$6)`,
      [safeName, r.score, r.minted, r.fragments, r.placement, mapIndex]
    );
    await query(
      `INSERT INTO player_stats (player_name, total_score, total_wins, total_rounds, total_minted, best_score)
       VALUES ($1, $2, $3, 1, $4, $5)
       ON CONFLICT (player_name) DO UPDATE SET
         total_score = player_stats.total_score + $2,
         total_wins = player_stats.total_wins + $3,
         total_rounds = player_stats.total_rounds + 1,
         total_minted = player_stats.total_minted + $4,
         best_score = GREATEST(player_stats.best_score, $5),
         updated_at = NOW()`,
      [safeName, r.score, r.placement === 1 ? 1 : 0, r.minted, r.score]
    );
  }
  console.log(`[MP] Saved ${results.length} results to DB`);
}
