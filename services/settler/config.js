/**
 * Worker configuration from env. The operator key lives here and in the
 * Pier env block for this service, nowhere else. Mainnet (chain 5042) is
 * refused unless ARC_MAINNET_CONFIRM=I_UNDERSTAND; phase 4 is testnet.
 */
import { getAddress } from "viem";

export function loadConfig(env = process.env) {
  const need = (k, re) => { const v = env[k]; if (!v || (re && !re.test(v))) throw new Error(`${k} missing or malformed`); return v; };
  const chainId = Number(env.CHAIN_ID) || 5042002;
  if (chainId === 5042 && env.ARC_MAINNET_CONFIRM !== "I_UNDERSTAND") throw new Error("CHAIN_ID 5042 is mainnet; refused without ARC_MAINNET_CONFIRM=I_UNDERSTAND");
  return {
    operatorKey: need("OPERATOR_KEY", /^0x[0-9a-fA-F]{64}$/),
    escrow: getAddress(need("ESCROW_ADDRESS", /^0x[0-9a-fA-F]{40}$/)),
    memo: getAddress(env.MEMO_ADDRESS || "0x5294E9927c3306DcBaDb03fe70b92e01cCede505"),
    chainId,
    rpcUrl: env.ARC_RPC_URL || (chainId === 5042002 ? "https://rpc.testnet.arc.io" : "http://127.0.0.1:8545"),
    databaseUrl: need("DATABASE_URL"),
    signerUrl: env.SIGNER_URL || "http://127.0.0.1:7520",
    signerToken: need("SIGNER_TOKEN"),
    pollMs: Number(env.POLL_MS) || 3000,
    receiptDeadlineMs: Number(env.RECEIPT_DEADLINE_MS) || 90_000,
    maxAttempts: Number(env.MAX_ATTEMPTS) || 3,
    useMemo: env.SETTLE_VIA_MEMO !== "0",
  };
}
