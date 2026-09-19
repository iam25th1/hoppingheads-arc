/**
 * Wallet admission gate
 *
 * Sign in with Ethereum style challenge. The server issues a nonce inside an
 * EIP-4361 shaped message, the client signs it with personal_sign, the server
 * recovers the signer with ethers.verifyMessage and, if it matches the claimed
 * address, issues a session token. Every identity in the game (lobby seat,
 * leaderboard row, later the stake) derives from that recovered address and
 * never from anything the client typed.
 *
 * No chain calls. Signature recovery is pure math; nothing here touches an
 * RPC or a contract. Phase 2 adds the stake on top of this identity.
 *
 * Wallets are free. The X account this replaces cost something to make;
 * an address costs nothing, so there can be no free entry tier that pays
 * anything, or the game is a faucet. The stake is the sybil cost. Guests can
 * play solo modes; they cannot take a lobby seat or write a result row.
 *
 * Fails closed: without SESSION_SECRET the auth routes answer 503, no token
 * is ever issued, and quickmatch denies everyone.
 */

import { Router } from "express";
import { ethers } from "ethers";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('[Auth] CRITICAL: SESSION_SECRET env var not set. Wallet sign in is disabled and no lobby is joinable.');
}
const SESSION_EXPIRY = "7d";
const NONCE_TTL_MS = 5 * 60 * 1000;
const NONCE_STORE_MAX = 5000; // bound on unauthenticated memory use
const CHAIN_ID = String(process.env.CHAIN_ID || "1"); // informational in the message, no RPC

// -- Nonce store ------------------------------------------------

// address (lowercase) -> { message, createdAt }
const nonceStore = new Map();

function sweepNonces(now) {
  for (const [addr, entry] of nonceStore) {
    if (now - entry.createdAt > NONCE_TTL_MS) nonceStore.delete(addr);
  }
}

// -- Helpers ----------------------------------------------------

/** Canonical lowercase address, or null if the input is not an address. */
export function normalizeAddress(value) {
  if (typeof value !== "string") return null;
  try {
    return ethers.getAddress(value).toLowerCase();
  } catch {
    return null;
  }
}

/** 0x1234..abcd, 12 chars, fits the existing 12 char name limit. */
export function shortAddress(address) {
  return `${address.slice(0, 6)}..${address.slice(-4)}`;
}

/** EIP-4361 message. domain and uri come from the request, not config. */
export function buildMessage({ domain, uri, address, nonce, issuedAt }) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    ethers.getAddress(address),
    "",
    "Sign in to Hopping Heads Arc. This request will not trigger a blockchain transaction or cost any gas.",
    "",
    `URI: ${uri}`,
    "Version: 1",
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

/**
 * Issue a challenge for an address. Returns the message to sign, or null when
 * the address is invalid. Throws 'nonce_store_full' when the bound is hit.
 */
export function issueChallenge(rawAddress, { domain, uri }, now = Date.now()) {
  const address = normalizeAddress(rawAddress);
  if (!address) return null;

  sweepNonces(now);
  if (!nonceStore.has(address) && nonceStore.size >= NONCE_STORE_MAX) {
    throw new Error("nonce_store_full");
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  const message = buildMessage({ domain, uri, address, nonce, issuedAt: new Date(now).toISOString() });
  nonceStore.set(address, { message, createdAt: now });
  return { address, message };
}

/**
 * Verify a signature against the pending challenge for the address. On
 * success the nonce is consumed and the recovered address is returned.
 * Returns null on any failure; the reason is not exposed to the caller.
 */
export function verifyChallenge(rawAddress, signature, now = Date.now()) {
  const address = normalizeAddress(rawAddress);
  if (!address || typeof signature !== "string") return null;

  const pending = nonceStore.get(address);
  if (!pending) return null;
  nonceStore.delete(address); // single use, success or not

  if (now - pending.createdAt > NONCE_TTL_MS) return null;

  let recovered;
  try {
    recovered = ethers.verifyMessage(pending.message, signature).toLowerCase();
  } catch {
    return null;
  }
  if (recovered !== address) return null;

  return address;
}

// -- Session tokens ----------------------------------------------

/** Signed session for a verified address. Null when the server has no secret. */
export function issueSession(address) {
  if (!SESSION_SECRET) return null;
  return jwt.sign({ sub: address }, SESSION_SECRET, { algorithm: "HS256", expiresIn: SESSION_EXPIRY });
}

/**
 * The address a session token was issued to, or null. This is the only way
 * the rest of the server learns who a client is.
 */
export function verifySessionToken(token) {
  if (!SESSION_SECRET || typeof token !== "string" || token.length === 0 || token.length > 2048) return null;
  try {
    const decoded = jwt.verify(token, SESSION_SECRET, { algorithms: ["HS256"] });
    return normalizeAddress(decoded.sub);
  } catch {
    return null;
  }
}

// -- Routes ---------------------------------------------------------

export const walletAuthRoutes = Router();

walletAuthRoutes.use((req, res, next) => {
  if (!SESSION_SECRET) return res.status(503).json({ error: "Sign in unavailable" });
  next();
});

// POST /auth/nonce { address } -> { message }
walletAuthRoutes.post("/nonce", (req, res) => {
  const domain = req.hostname;
  const uri = `${req.protocol}://${req.get("host")}`;
  let challenge;
  try {
    challenge = issueChallenge(req.body?.address, { domain, uri });
  } catch {
    return res.status(429).json({ error: "Too many pending sign ins, try again shortly" });
  }
  if (!challenge) return res.status(400).json({ error: "Invalid address" });
  res.json({ message: challenge.message });
});

// POST /auth/verify { address, signature } -> { token, address }
walletAuthRoutes.post("/verify", (req, res) => {
  const address = verifyChallenge(req.body?.address, req.body?.signature);
  if (!address) return res.status(401).json({ error: "Signature verification failed" });
  const token = issueSession(address);
  if (!token) return res.status(503).json({ error: "Sign in unavailable" });
  res.json({ token, address });
});

// GET /auth/me?token= -> { address } or { address: null }
walletAuthRoutes.get("/me", (req, res) => {
  const address = verifySessionToken(req.query.token);
  res.json({ address });
});
