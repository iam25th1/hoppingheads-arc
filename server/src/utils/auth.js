/**
 * Auth Utils
 *
 * Wallet-based authentication using signed messages.
 * Player signs a nonce with their wallet, backend verifies
 * the signature and issues a JWT for subsequent requests.
 */

import { ethers } from "ethers";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[Auth] CRITICAL: JWT_SECRET env var not set. Auth endpoints will fail.');
}
const JWT_EXPIRY = "24h";

// In-memory nonce store (use Redis in production)
const nonceStore = new Map();

/**
 * Generate a nonce for a wallet to sign.
 */
export function generateNonce(wallet) {
  const nonce = crypto.randomBytes(32).toString("hex");
  const message = `Sign this message to authenticate with Hopping Heads.\n\nNonce: ${nonce}\nWallet: ${wallet.toLowerCase()}`;
  nonceStore.set(wallet.toLowerCase(), { nonce, message, createdAt: Date.now() });

  // Expire nonce after 5 minutes
  setTimeout(() => nonceStore.delete(wallet.toLowerCase()), 300000);

  return { nonce, message };
}

/**
 * Verify a signed message and return a JWT if valid.
 */
export function verifySignature(wallet, signature) {
  const walletLower = wallet.toLowerCase();
  const stored = nonceStore.get(walletLower);
  if (!stored) throw new Error("No pending nonce for this wallet");

  // Check nonce age (5 min max)
  if (Date.now() - stored.createdAt > 300000) {
    nonceStore.delete(walletLower);
    throw new Error("Nonce expired");
  }

  // Recover signer from signature
  const recoveredAddress = ethers.verifyMessage(stored.message, signature);
  if (recoveredAddress.toLowerCase() !== walletLower) {
    throw new Error("Signature verification failed");
  }

  // Consume the nonce
  nonceStore.delete(walletLower);

  // Refuse to issue tokens if secret not configured
  if (!JWT_SECRET) {
    throw new Error("Server misconfigured: JWT_SECRET not set");
  }

  // Issue JWT
  const token = jwt.sign(
    { wallet: walletLower },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );

  return { token, wallet: walletLower };
}

/**
 * Express middleware to verify JWT on protected routes.
 */
export function authMiddleware(req, res, next) {
  if (!JWT_SECRET) {
    return res.status(503).json({ error: "Auth unavailable" });
  }
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing auth token" });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.wallet = decoded.wallet;
    next();
  } catch (_) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
