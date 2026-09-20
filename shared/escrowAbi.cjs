/**
 * ArenaEscrow calls, encoded by hand.
 *
 * One file, loaded by both sides, like prng.cjs and layout.cjs: the server
 * requires it and tests every encoder against ethers, the client loads it as
 * a classic script (/game/lib/escrowAbi.js, globalThis.HHEscrow) and speaks
 * to the wallet with it. The client has no ABI library; these are the few
 * fixed signatures it needs, with selectors from cast sig, and the Permit2
 * typed data a wallet signs for a one signature entry.
 *
 * Amounts are USDC units (6 decimals). Nothing here knows about gwei except
 * the fee floor the client must put on every transaction it sends.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HHEscrow = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SEL = {
    enterWithPermit2: "0x4148f524", // enterWithPermit2(bytes32,uint256,uint256,bytes)
    enter: "0x568ab21e",            // enter(bytes32)
    withdraw: "0x3ccfd60b",         // withdraw()
    approve: "0x095ea7b3",          // approve(address,uint256)
    allowance: "0xdd62ed3e",        // allowance(address,address)
    claimable: "0x402914f5",        // claimable(address)
    entered: "0xf41349f0",          // entered(bytes32,address)
    balanceOf: "0x70a08231",        // balanceOf(address)
    entryAmount: "0x991def3c",      // entryAmount()
  };
  const FEE_FLOOR_WEI = "20000000000"; // 20 gwei: Arc drops anything under it, silently
  const MAX_UINT256 = "0x" + "f".repeat(64);
  const HEX = /^0x[0-9a-fA-F]*$/;

  function word(hex) {
    if (typeof hex !== "string" || !HEX.test(hex) || hex.length > 66) throw new TypeError("escrow: bad hex word");
    return hex.slice(2).toLowerCase().padStart(64, "0");
  }
  function uint(v) {
    const n = typeof v === "bigint" ? v : BigInt(v);
    if (n < 0n) throw new TypeError("escrow: negative uint");
    return word("0x" + n.toString(16));
  }
  function address(a) {
    if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new TypeError("escrow: bad address");
    return word(a);
  }
  function bytes32(h) {
    if (typeof h !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(h)) throw new TypeError("escrow: bad bytes32");
    return word(h);
  }
  function bytesTail(h) {
    if (typeof h !== "string" || !HEX.test(h) || h.length % 2) throw new TypeError("escrow: bad bytes");
    const body = h.slice(2).toLowerCase();
    const len = body.length / 2;
    const pad = (64 - (body.length % 64)) % 64;
    return uint(len) + body + "0".repeat(pad);
  }

  return {
    SEL: SEL,
    FEE_FLOOR_WEI: FEE_FLOOR_WEI,
    MAX_UINT256: MAX_UINT256,
    encodeEnterWithPermit2: function (roundId, nonce, deadline, signature) {
      // head: roundId, nonce, deadline, offset of the bytes (4 words in); tail: length, data
      return SEL.enterWithPermit2 + bytes32(roundId) + uint(nonce) + uint(deadline) + uint(128) + bytesTail(signature);
    },
    encodeEnter: function (roundId) { return SEL.enter + bytes32(roundId); },
    encodeWithdraw: function () { return SEL.withdraw; },
    encodeApprove: function (spender, amount) { return SEL.approve + address(spender) + uint(amount); },
    encodeAllowance: function (owner, spender) { return SEL.allowance + address(owner) + address(spender); },
    encodeClaimable: function (a) { return SEL.claimable + address(a); },
    encodeEntered: function (roundId, a) { return SEL.entered + bytes32(roundId) + address(a); },
    encodeBalanceOf: function (a) { return SEL.balanceOf + address(a); },
    encodeEntryAmount: function () { return SEL.entryAmount; },
    /** A uint256 return value. */
    decodeUint: function (hex) {
      if (typeof hex !== "string" || !HEX.test(hex) || hex.length < 66) throw new TypeError("escrow: bad uint return");
      return BigInt("0x" + hex.slice(2, 66));
    },
    decodeBool: function (hex) {
      if (typeof hex !== "string" || !HEX.test(hex) || hex.length < 66) throw new TypeError("escrow: bad bool return");
      return BigInt("0x" + hex.slice(2, 66)) === 1n;
    },
    /** 500000 to "$0.50". Dollars, never units, never gwei, in anything a player reads. */
    usd: function (units) {
      const n = Number(typeof units === "bigint" ? units : BigInt(units)) / 1e6;
      return "$" + n.toFixed(2);
    },
    /** A 31 byte random nonce for Permit2's unordered nonces. rnd: 31 random bytes. */
    permit2Nonce: function (bytes31) {
      let h = "0x";
      for (let i = 0; i < bytes31.length; i++) h += bytes31[i].toString(16).padStart(2, "0");
      return BigInt(h).toString();
    },
    /**
     * The typed data a wallet signs for a one signature entry: Permit2's
     * PermitTransferFrom, spender the escrow, amount the entry, one hour deadline.
     * Shaped for eth_signTypedData_v4 (EIP712Domain listed in types).
     */
    permit2TypedData: function (p) {
      return {
        types: {
          EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
          PermitTransferFrom: [{ name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
          TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
        },
        domain: { name: "Permit2", chainId: p.chainId, verifyingContract: p.permit2 },
        primaryType: "PermitTransferFrom",
        message: { permitted: { token: p.token, amount: String(p.amount) }, spender: p.spender, nonce: String(p.nonce), deadline: String(p.deadline) },
      };
    },
  };
});
