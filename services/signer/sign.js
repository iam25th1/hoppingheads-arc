/**
 * The settlement signer.
 *
 * One struct, one key, one job: sign the EIP-712 Settlement that ArenaEscrow
 * verifies in settleRound. The key comes in through SIGNER_KEY and lives only
 * in this process; the game server never sees it, and the settlement worker
 * asks this service for a signature over loopback with a shared token.
 *
 * The typed data here must match the contract byte for byte:
 *   Settlement(bytes32 roundId,bytes32 seed,Placement[] placements)
 *   Placement(address player,uint8 place)
 * under the domain { name: "ArenaEscrow", version: "1", chainId, verifyingContract }.
 * settle.js in the worker reads settlementDigest from the contract and refuses
 * to submit if the two disagree.
 */

import { Wallet, TypedDataEncoder, isAddress, getAddress } from "ethers";

export const SETTLEMENT_TYPES = {
  Settlement: [
    { name: "roundId", type: "bytes32" },
    { name: "seed", type: "bytes32" },
    { name: "placements", type: "Placement[]" },
  ],
  Placement: [
    { name: "player", type: "address" },
    { name: "place", type: "uint8" },
  ],
};

export const MAX_PLACEMENTS = 8;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export function domainFor(chainId, escrow) {
  if (!Number.isInteger(chainId) || chainId <= 0) throw new TypeError("domain: bad chainId");
  if (!isAddress(escrow)) throw new TypeError("domain: bad escrow address");
  return { name: "ArenaEscrow", version: "1", chainId, verifyingContract: getAddress(escrow) };
}

/**
 * Validate a settlement request. Returns the normalised value or throws a
 * TypeError naming the field. Every check the contract makes on shape is made
 * here first, so a bad request never reaches the key.
 */
export function validateSettlement(body) {
  if (!body || typeof body !== "object") throw new TypeError("settlement: body must be an object");
  const { roundId, seed, placements } = body;
  if (typeof roundId !== "string" || !HEX32.test(roundId)) throw new TypeError("settlement: roundId must be 0x plus 64 hex digits");
  if (typeof seed !== "string" || !HEX32.test(seed)) throw new TypeError("settlement: seed must be 0x plus 64 hex digits");
  if (!Array.isArray(placements)) throw new TypeError("settlement: placements must be an array");
  if (placements.length > MAX_PLACEMENTS) throw new TypeError(`settlement: at most ${MAX_PLACEMENTS} placements`);
  const seen = new Set();
  const out = placements.map((p, i) => {
    if (!p || typeof p !== "object") throw new TypeError(`settlement: placement ${i} must be an object`);
    if (typeof p.player !== "string" || !isAddress(p.player)) throw new TypeError(`settlement: placement ${i} player must be an address`);
    const player = getAddress(p.player);
    if (player === "0x0000000000000000000000000000000000000000") throw new TypeError(`settlement: placement ${i} player is the zero address`);
    if (seen.has(player)) throw new TypeError(`settlement: placement ${i} repeats ${player}`);
    seen.add(player);
    if (!Number.isInteger(p.place) || p.place < 1 || p.place > 255) throw new TypeError(`settlement: placement ${i} place must be 1 to 255`);
    return { player, place: p.place };
  });
  return { roundId: roundId.toLowerCase(), seed: seed.toLowerCase(), placements: out };
}

/** The EIP-712 digest the contract computes in settlementDigest. */
export function settlementDigest(domain, value) {
  return TypedDataEncoder.hash(domain, SETTLEMENT_TYPES, value);
}

/** Sign a validated settlement. Returns the digest, the signature and the signer address. */
export async function signSettlement(wallet, domain, value) {
  const signature = await wallet.signTypedData(domain, SETTLEMENT_TYPES, value);
  return { digest: settlementDigest(domain, value), signature, signer: wallet.address };
}

/** A wallet from the env key, or a clear error. The key is never logged. */
export function walletFromEnv(env = process.env) {
  const key = env.SIGNER_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("SIGNER_KEY missing or malformed");
  return new Wallet(key);
}
