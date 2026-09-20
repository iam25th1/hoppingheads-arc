/**
 * hh-arc-signer: an HTTP service on loopback that signs ArenaEscrow settlements.
 *
 *   GET  /health                 -> { ok, signer, chainId, escrow }
 *   POST /sign  (x-signer-token) -> { digest, signature, signer }
 *
 * Env: SIGNER_KEY (the only key), SIGNER_TOKEN (shared with the settlement
 * worker), CHAIN_ID, ESCROW_ADDRESS, PORT, BIND (default 127.0.0.1). It binds
 * to loopback unless told otherwise, holds no database connection, and signs
 * exactly one struct. Every signature is logged with its roundId and digest.
 */

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { domainFor, validateSettlement, signSettlement, walletFromEnv } from "./sign.js";

const PORT = Number(process.env.PORT) || 7520;
const BIND = process.env.BIND || "127.0.0.1";
const TOKEN = process.env.SIGNER_TOKEN || "";
const MAX_BODY = 16 * 1024;

if (TOKEN.length < 32) { console.error("[Signer] SIGNER_TOKEN missing or under 32 characters; refusing to start"); process.exit(1); }
let wallet, domain;
try {
  wallet = walletFromEnv();
  domain = domainFor(Number(process.env.CHAIN_ID), process.env.ESCROW_ADDRESS);
} catch (e) { console.error(`[Signer] ${e.message}; refusing to start`); process.exit(1); }

function tokenOk(header) {
  if (typeof header !== "string" || header.length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(TOKEN));
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json), "cache-control": "no-store" });
  res.end(json);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, signer: wallet.address, chainId: domain.chainId, escrow: domain.verifyingContract });
  if (req.method !== "POST" || req.url !== "/sign") return send(res, 404, { error: "not found" });
  if (!tokenOk(req.headers["x-signer-token"])) return send(res, 401, { error: "unauthorised" });
  let body = "", size = 0;
  req.on("data", (chunk) => { size += chunk.length; if (size > MAX_BODY) { req.destroy(); return; } body += chunk; });
  req.on("end", async () => {
    let value;
    try { value = validateSettlement(JSON.parse(body)); } catch (e) { return send(res, 400, { error: e.message }); }
    try {
      const out = await signSettlement(wallet, domain, value);
      console.log(`[Signer] signed round ${value.roundId} digest ${out.digest} placements ${value.placements.length}`);
      send(res, 200, out);
    } catch (e) { console.error(`[Signer] sign failed: ${e.message}`); send(res, 500, { error: "sign failed" }); }
  });
});

server.listen(PORT, BIND, () => console.log(`[Signer] ${wallet.address} for ${domain.verifyingContract} on chain ${domain.chainId}, listening on ${BIND}:${PORT}`));
