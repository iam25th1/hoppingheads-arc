/**
 * Quick-Match Game Socket - Hardened v2
 * Security: input validation, rate limiting, anti-cheat, XSS prevention
 */

import crypto from "crypto";
import { createRequire } from "module";
import { query } from "../db/pool.js";
import { issueRound } from "../game/rounds.js";
import { createFragState, MINT_LIMIT, MINT_DURATIONS, MINT_GRACE_MS } from "../game/lobbyFrags.js";
import { collectFragment, completeMint, hasMintableChest } from "../game/lobbyActions.js";
import { lobbyModeFor, rulesFor } from "../game/modes.js";
import { grantKnockback, judgeMove, BASE_SPEED, BOOST_SPEED } from "../game/movement.js";
import { createSeat, fillWithBots, countSeats, BOT_FILL_TO, DEFAULT_SKINS } from "../game/bots.js";
import { createBotBrain, stepBot, BOT_SPEED } from "../game/botDriver.js";
import { createPowerupState, spawnIfDue, expire, pickups, hasEffect } from "../game/powerups.js";
import { isBotId, isHumanId, guestId } from "../game/ids.js";

const require = createRequire(import.meta.url);
const layoutModule = require("../../../shared/layout.cjs");
import { verifySessionToken, shortAddress } from "../utils/walletAuth.js";

const TICK_RATE = 100;
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const ROUND_DURATION = Number(process.env.ROUND_SECONDS) || 180;   // env override for tests only
const LOBBY_WAIT_TIME = Number(process.env.LOBBY_WAIT_SECONDS) || 30; // seconds to wait before starting with fewer than 8
const MAP_HALF = 150; // MAP/2

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

function createLobby(mode) {
  const id = nextLobbyId++;
  const lobby = {
    id, mode, rules: rulesFor(mode), status:'waiting', players:new Map(),
    mapIndex: crypto.randomInt(6),
    seed: null, roundId: null, // issued by the server at round start
    startTime:null, endTime:null,
    tickInterval:null, countdownInterval:null, autoStartTimer:null,
    waitStartedAt:null, waitTickInterval:null,
    createdAt:Date.now(),
  };
  lobbies.set(id, lobby);
  return lobby;
}

/**
 * The one movement path. A human's pos update and a bot's tick both land
 * here: the ceiling is computed from the seat, the move is judged over the
 * window with knockback as a budget (movement.js), overspeed is clamped and
 * counted, never ejected. Logged on the first three flags and every fiftieth
 * after, so a real cheat cannot flood the log.
 */
function applyMove(p, nx, nz, ry, moving, now) {
  // The cap is per seat: base speed, or the boosted speed only while the
  // server's own powerup record says this seat is boosted. Grow slows a
  // player (mirrors client GROW_PER_FRAG and SPEED_PENALTY_MAX).
  const cap = hasEffect(p, 'speed', now) ? BOOST_SPEED : BASE_SPEED;
  const growFactor = Math.min(1, (p.fragCount * 0.022) / 1.2);
  const adjustedMaxSpeed = cap * (1 - growFactor * 0.45);
  const judged = judgeMove(p.move, nx, nz, now, adjustedMaxSpeed);
  if (judged.flagged) {
    p.violations.move++;
    if (p.violations.move <= 3 || p.violations.move % 50 === 0) {
      console.warn(`[MP] FLAG pos ${p.id} path ${judged.path.toFixed(1)} over ${judged.spanMs}ms, allowed ${judged.allowance.toFixed(1)}, step ${judged.step.toFixed(1)} (count ${p.violations.move})`);
    }
  }
  p.x = judged.x;
  p.z = judged.z;
  p.y = 0; // Y is always 0 (flat ground - LOCKED)
  p.ry = ry;
  p.moving = moving;
  return judged;
}

/**
 * Bind lobbyActions' emit to socket.io: with a seat, to that seat's socket
 * (a bot has none, so nothing is sent); without, to the lobby room.
 */
function lobbyEmit(io, lobby) {
  return (event, payload, seat) => {
    if (!seat) { io.to(`lobby:${lobby.id}`).emit(event, payload); return; }
    if (!seat.socketId) return;
    const s = io.sockets.sockets.get(seat.socketId);
    if (s) s.emit(event, payload);
  };
}

/**
 * Powerups on the tick: spawn when due, expire, and award pickups by the
 * server's own tracked positions, bots included. No claim event exists.
 */
function tickPowerups(io, lobby, now) {
  const st = lobby.powerups;
  if (!st) return;
  const pw = spawnIfDue(st, now);
  if (pw) io.to(`lobby:${lobby.id}`).emit('pw:spawn', { id: pw.id, type: pw.type, x: pw.x, z: pw.z });
  for (const id of expire(st, now)) io.to(`lobby:${lobby.id}`).emit('pw:expire', { id });
  for (const t of pickups(st, [...lobby.players.values()], now)) io.to(`lobby:${lobby.id}`).emit('pw:taken', t);
}

/** Slot n of a bot id, for its stream. */
function botSlot(id) {
  return Number(id.split(":")[2]);
}

/**
 * Drive every bot one tick: decide, move through applyMove, and claim or
 * mint through the same validated actions a human's socket events call.
 */
function driveBots(io, lobby, now) {
  const dt = lobby.lastTickAt ? (now - lobby.lastTickAt) / 1000 : 0.1;
  lobby.lastTickAt = now;
  if (!lobby.frags) return;
  // The world a bot sees: unclaimed fragments and human positions.
  const snapshot = () => { const out = []; for (const f of lobby.frags.frags.values()) if (f.claimedBy === null) out.push({ id: f.id, x: f.x, z: f.z }); return out; };
  const humans = [];
  for (const p of lobby.players.values()) if (!p.isBot) humans.push({ x: p.x, z: p.z });
  const world = { fragments: snapshot(), humans };
  const emit = lobbyEmit(io, lobby);
  for (const p of lobby.players.values()) {
    if (!p.isBot || !p.brain) continue;
    // A bot the server knows is boosted runs at the boosted speed, like a human would
    const speed = hasEffect(p, 'speed', now) ? BOT_SPEED * 2 : BOT_SPEED;
    const r = stepBot(p.brain, p, world, speed, dt);
    applyMove(p, r.nx, r.nz, r.ry, r.moving, now);
    // Same path as frag:collected. The judge may have clamped the bot short
    // of where the driver wanted it; then this is rejected as range, which
    // is the point: a bot has no side door.
    if (r.claimId !== null) {
      const c = collectFragment(lobby, p, r.claimId, emit, now);
      // Later bots in this tick see the world as it now is
      if (c.ok) { const i = world.fragments.findIndex((f) => f.id === r.claimId); if (i >= 0) world.fragments.splice(i, 1); }
    }
    if (lobby.rules.mints && hasMintableChest(p, now, MINT_DURATIONS, MINT_GRACE_MS)) {
      // A mint respawns a rarity; later bots in this tick must see the new positions
      if (completeMint(lobby, p, emit, now).ok) world.fragments = snapshot();
    }
  }
}

function findOpenLobby(mode) {
  for (const [id, lobby] of lobbies) {
    if (lobby.mode === mode && lobby.status === 'waiting' && lobby.players.size < MAX_PLAYERS) return lobby;
  }
  return null;
}

export function initGameSocket(io) {
  io.on('connection', (socket) => {
    let playerId = null;
    let currentLobby = null;
    let hasJoined = false;
    let verifiedUser = null; // recovered wallet address

    // Per-event rate limiters
    const posLimiter = createRateLimiter(15);  // 15 pos updates/sec max
    const fragLimiter = createRateLimiter(3);  // 3 frag collects/sec max
    const mintLimiter = createRateLimiter(1);  // 1 mint/sec max
    const boinkLimiter = createRateLimiter(2); // 2 boinks/sec max

    socket.on('quickmatch', async ({ name, skin, session, mode }) => {
      // Prevent double-join
      if (hasJoined) return;

      // WALLET GATE. The arena needs a verified wallet. A sandbox lobby seats
      // a guest under a random guest id, which can never be an address, so
      // nothing it writes can ever be paid.
      const lobbyMode = lobbyModeFor(mode);
      const rules = rulesFor(lobbyMode);
      const address = verifySessionToken(session);
      if (!address && !rules.guests) {
        socket.emit('auth:denied', { reason: 'Connect a wallet to enter the arena.' });
        return;
      }
      if (address) {
        // One seat per address across live lobbies
        for (const l of lobbies.values()) {
          if (l.status !== 'ended' && l.players.has(address)) {
            socket.emit('auth:denied', { reason: 'This wallet is already in a lobby.' });
            return;
          }
        }
      }
      verifiedUser = address;
      hasJoined = true;

      // Identity is the recovered address, or a guest id in the sandbox. Never the client name.
      playerId = address || guestId(crypto.randomBytes(8).toString('hex'));
      const pName = address ? shortAddress(address) : 'GUEST';

      // Lobbies are per mode. The server selects the ruleset; the client only asks.
      let lobby = findOpenLobby(lobbyMode);
      if (!lobby) lobby = createLobby(lobbyMode);

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

      // One seat shape for humans and bots (bots.js). cosmeticExtras is
      // always {} since phase 0; kept on the seat for the joined payload.
      lobby.players.set(playerId, createSeat({
        id: playerId, socketId: socket.id, name: pName, address, appearance, index: playerIndex,
        isBot: false, maxMints: MINT_LIMIT,
      }));

      currentLobby = lobby;
      socket.join(`lobby:${lobby.id}`);

      socket.emit('joined', {
        playerId, lobbyId: lobby.id, mode: lobby.mode,
        mapIndex: lobby.mapIndex,
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
        beginCountdown(io, lobby).catch((e) => console.error('[MP] Countdown failed:', e.message));
      }
      // Enough to start a wait: MIN_PLAYERS humans, or a single human when the
      // mode fills empty seats with bots at countdown.
      else if (lobby.players.size >= (lobby.rules.bots ? 1 : MIN_PLAYERS) && !lobby.waitStartedAt && lobby.status === 'waiting') {
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
            beginCountdown(io, lobby).catch((e) => console.error('[MP] Countdown failed:', e.message));
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

      applyMove(p, nx, nz, nry, !!moving, Date.now());
    });

    socket.on('frag:collected', ({ id }) => {
      if (!currentLobby || !playerId) return;
      if (!fragLimiter()) return;
      const p = currentLobby.players.get(playerId);
      if (!p) return;
      // The one collection path, shared with bots (lobbyActions.js)
      collectFragment(currentLobby, p, id, lobbyEmit(io, currentLobby));
    });

    socket.on('mint:done', () => {
      if (!currentLobby || !playerId) return;
      if (!mintLimiter()) return;
      const p = currentLobby.players.get(playerId);
      if (!p) return;
      // The one mint path, shared with bots (lobbyActions.js)
      completeMint(currentLobby, p, lobbyEmit(io, currentLobby));
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

      // The target is about to be knocked back by the client; give the
      // movement judge the budget to accept it, once.
      grantKnockback(targetPlayer.move, Date.now());

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

      // No humans left: tear the lobby down. Bots never leave on their own,
      // so a size check alone would keep a bot only round running to the end.
      if (countSeats(currentLobby.players).humans === 0) {
        if (currentLobby.waitTickInterval) clearInterval(currentLobby.waitTickInterval); // or an empty lobby counts down and plays alone
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

async function beginCountdown(io, lobby) {
  lobby.status = 'countdown';
  if (lobby.waitTickInterval) { clearInterval(lobby.waitTickInterval); lobby.waitTickInterval = null; }
  // The seed is issued here, at countdown, so bot ids can carry the run's
  // seed prefix (ids.js). It reaches clients on round:start as before.
  const round = await issueRound({ mode: lobby.rules.roundMode, mapIndex: lobby.mapIndex, maxPlayers: MAX_PLAYERS, durationSecs: ROUND_DURATION, stakeable: lobby.rules.stakeable });
  lobby.seed = round.seed;
  lobby.roundId = round.id;
  // Fill empty seats with bots. They join the roster like anyone else.
  if (lobby.rules.bots && lobby.players.size < BOT_FILL_TO) {
    for (const bot of fillWithBots(lobby, lobby.seed, BOT_FILL_TO, MAX_PLAYERS, MINT_LIMIT)) {
      io.to(`lobby:${lobby.id}`).emit('player:joined', { id: bot.id, name: bot.name, appearance: bot.appearance, extras: {}, count: lobby.players.size });
    }
    const c = countSeats(lobby.players);
    console.log(`[MP] Lobby ${lobby.id} filled with ${c.bots} bot(s) alongside ${c.humans} human(s)`);
  }
  let count = 3;
  io.to(`lobby:${lobby.id}`).emit('countdown', { count });
  lobby.countdownInterval = setInterval(() => {
    count--;
    if (count > 0) {
      io.to(`lobby:${lobby.id}`).emit('countdown', { count });
    } else {
      clearInterval(lobby.countdownInterval);
      startRound(io, lobby).catch((e) => console.error('[MP] Round start failed:', e.message));
    }
  }, 1000);
}

async function startRound(io, lobby) {
  // The seed was issued at countdown and written to the round row before any
  // client saw it. The client builds the fragment layout from exactly what
  // this emits, through the same shared module the lobby uses.
  if (!lobby.seed) throw new Error('startRound before the seed was issued');
  // The lobby holds the fragment state for the round, built from the same
  // shared module the client uses, so both sides agree on every position.
  // A mode without fragments holds none, and any claim is wrong_mode.
  lobby.frags = lobby.rules.fragments ? createFragState(layoutModule.createLayout(lobby.seed, lobby.mapIndex)) : null;
  // Every bot gets a brain: a stream derived from the round seed and its slot.
  for (const p of lobby.players.values()) if (p.isBot) p.brain = createBotBrain(lobby.seed, botSlot(p.id));
  lobby.lastTickAt = null;
  // Powerups: schedule, type and position off the seed; pickups by proximity on the tick
  lobby.powerups = lobby.rules.powerups ? createPowerupState(lobby.seed, lobby.mapIndex, Date.now()) : null; // now, not lobby.startTime, which is set further down

  lobby.status = 'active';
  lobby.startTime = Date.now();
  lobby.endTime = lobby.startTime + ROUND_DURATION * 1000;

  io.to(`lobby:${lobby.id}`).emit('round:start', {
    duration:ROUND_DURATION, endTime:lobby.endTime,
    seed:lobby.seed, mapIndex:lobby.mapIndex, mode:lobby.mode,
  });

  console.log(`[MP] Round started lobby ${lobby.id} mode=${lobby.mode} (${lobby.players.size} players)`);

  lobby.tickInterval = setInterval(() => {
    if (lobby.status !== 'active') { clearInterval(lobby.tickInterval); return; }

    const tickNow = Date.now();
    const timeLeft = Math.max(0, lobby.endTime - tickNow);
    driveBots(io, lobby, tickNow);
    tickPowerups(io, lobby, tickNow);
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
      fragments:p.fragments.reduce((a,b)=>a+b,0) }))
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ ...r, placement:i+1 }));

  // Refused claims and movement flags per player. Zero for honest clients;
  // anything else is the trail phase 5 reads.
  for (const p of lobby.players.values()) {
    if (p.rejections.total > 0 || p.violations.move > 0) {
      console.warn(`[MP] Flags lobby ${lobby.id} ${p.id}: rejections=${JSON.stringify(p.rejections)} moveClamps=${p.violations.move}`);
    }
  }

  // Emit the public result fields only
  io.to(`lobby:${lobby.id}`).emit('round:end', { results: results.map(r => ({
    id:r.id, name:r.name, score:r.score, minted:r.minted, fragments:r.fragments, placement:r.placement
  }))});
  console.log(`[MP] Round ended lobby ${lobby.id}. Winner: ${results[0]?.name} (${results[0]?.score})`);

  saveResults(results, lobby).catch(e => console.error('[MP] Save error:', e.message));
  setTimeout(() => lobbies.delete(lobby.id), 30000);
}

async function saveResults(results, lobby) {
  // The rounds row was written when the seed was issued at round start.
  // Close it here. commit_hash, signature and tx_hash stay null until
  // phases 2 and 3. If the row could not be written then (database down at
  // issue time), write it now so the seed is never lost.
  let roundId = lobby.roundId;
  if (roundId) {
    await query(
      `UPDATE rounds SET status = 'completed', end_time = to_timestamp($2 / 1000.0), winner = $3 WHERE id = $1`,
      [roundId, lobby.endTime, results[0]?.id ?? null]
    );
  } else {
    const round = await query(
      `INSERT INTO rounds (mode, map_index, seed, status, max_players, duration_secs, start_time, end_time, winner, stakeable)
       VALUES ($8, $1, $2, 'completed', $3, $4, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0), $7, $9) RETURNING id`,
      [lobby.mapIndex, lobby.seed, MAX_PLAYERS, ROUND_DURATION, lobby.startTime, lobby.endTime, results[0]?.id ?? null, lobby.rules.roundMode, lobby.rules.stakeable === true]
    );
    roundId = round.rows[0].id;
  }
  for (const r of results) {
    // r.id is the recovered address. Every seat written here is human;
    // a bot seat would carry a bot id and is_bot true (see game/ids.js).
    const isBot = isBotId(r.id);
    await query(
      `INSERT INTO round_results (round_id, participant, is_bot, score, minted, fragments, placement)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [roundId, r.id, isBot, r.score, r.minted, r.fragments, r.placement]
    );
    if (!isHumanId(r.id)) continue; // stats are for wallets: not bots, not guests
    await query(
      `INSERT INTO player_stats (address, total_score, total_wins, total_rounds, total_minted, best_score)
       VALUES ($1, $2, $3, 1, $4, $5)
       ON CONFLICT (address) DO UPDATE SET
         total_score = player_stats.total_score + $2,
         total_wins = player_stats.total_wins + $3,
         total_rounds = player_stats.total_rounds + 1,
         total_minted = player_stats.total_minted + $4,
         best_score = GREATEST(player_stats.best_score, $5),
         updated_at = NOW()`,
      [r.id, r.score, r.placement === 1 ? 1 : 0, r.minted, r.score]
    );
  }
  console.log(`[MP] Saved round ${roundId} with ${results.length} results`);
}
